// Handing a parked run's question to a room's agent, and remembering which thread it went to. Core
// posts nothing of its own (ISS-873): the agent first answers it from the record, and nothing is
// posted; only where a person is needed does it write the question (`question-voice.ts`), which goes
// inside a thread — the one it was raised in, or the room's one thread for the day's questions,
// opened by the agent's own line — never at the room's top level, and never twice. A round it could
// not settle is retried; the ledger of owed rounds and its operator alerts are `question-ledger.ts`.

import { and, eq, ne } from 'drizzle-orm';
import { roomLanguageOf } from '../../conversations/index.js';
import { db } from '../../db/client.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { rocketchatQuestionDeliveries, rocketchatThreads } from '../../db/schema-rocketchat.js';
import {
  dailyThread,
  keepDailyThread,
  liveConnectionFor,
  namespaceFromServerUrl,
  type RocketChatRestAuth,
  registerThread,
  releaseQuestionThread,
  resolveRoomPostAuth,
  sendFixedReply,
  utcDayOf,
} from '../../integrations/rocketchat/index.js';
import { issueDisplayIds } from '../../issues/index.js';
import { logger } from '../../lib/logger.js';
import type { ProvenMessage } from '../../messaging/proven.js';
import {
  isUnreachableRoom,
  type QuestionDestination,
  resolveQuestionDestination,
} from './question-destination.js';
import {
  claimRound,
  clearWebDecidedAlerts,
  MAX_ATTEMPTS,
  type OwedRound,
  owedRounds,
  reportUndeliverable,
  resolveUndeliverableAlert,
  roundOf,
  settle,
} from './question-ledger.js';
import { questionRecord } from './question-record.js';
import { agentAsks, agentOpensDay, roundFacts, type Spoken } from './question-voice.js';

/** A round handed to the project's channel agent (ISS-873): its facts and the record about it. */
export interface ChannelAgentRound {
  questionId: string;
  projectId: string;
  round: number;
  facts: string;
  record: Record<string, unknown>;
}

/**
 * Hands a round to the project's channel agent: `none` where the project has none, `handed`, or
 * why it can be handed nowhere. The support module provides it at boot.
 */
type ChannelAgentQuestions = (
  round: ChannelAgentRound,
) => Promise<'none' | 'handed' | { refused: string }>;

let channelAgentQuestions: ChannelAgentQuestions = async () => 'none';

export function provideChannelAgentQuestions(port: ChannelAgentQuestions): void {
  channelAgentQuestions = port;
}

async function noteFailure(
  owed: OwedRound,
  attempt: number,
  lastError: string,
  now: Date,
): Promise<'failed' | 'undeliverable'> {
  if (attempt >= MAX_ATTEMPTS) {
    return refuse(
      owed,
      `this round failed ${attempt} times and will not be retried on the ordinary schedule — the last failure was: ${lastError}`,
      now,
    );
  }
  await db
    .update(rocketchatQuestionDeliveries)
    .set({ lastError, updatedAt: now })
    .where(roundOf(owed));
  return 'failed';
}

type Outcome = 'delivered' | 'failed' | 'undeliverable' | 'held';
type RoomDestination = Extract<QuestionDestination, { kind: 'room' }>;
type Prepared = {
  attempt: number;
  destination: RoomDestination;
  proven: ProvenMessage;
  auth: RocketChatRestAuth;
  botName: string | undefined;
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Deliver one owed round. Never throws — a failure is a record, not an exception.
 */
async function deliverOwedRound(owed: OwedRound, now: Date = new Date()): Promise<Outcome> {
  const prepared = await prepareRound(owed, now);
  return typeof prepared === 'string' ? prepared : postRound(owed, prepared, now);
}

/**
 * The thread an open question on the same issue, with the same words, was already asked in: the
 * room is not asked twice (ISS-873).
 */
async function sameQuestionThread(
  questionId: string,
  projectId: string,
  issueId: string | null,
  prompt: string,
): Promise<{ connectionId: string; rid: string; tmid: string } | null> {
  if (!issueId) return null;
  const asked = await db
    .select({
      connectionId: rocketchatThreads.connectionId,
      rid: rocketchatThreads.rid,
      tmid: rocketchatThreads.tmid,
      steps: agentQuestions.steps,
    })
    .from(agentQuestions)
    .innerJoin(rocketchatThreads, eq(rocketchatThreads.questionId, agentQuestions.id))
    .where(
      and(
        eq(agentQuestions.projectId, projectId),
        eq(agentQuestions.issueId, issueId),
        eq(agentQuestions.status, 'open'),
        ne(agentQuestions.id, questionId),
      ),
    );
  const same = asked.find((a) => a.steps.at(-1)?.prompt.trim() === prompt.trim());
  return same ? { connectionId: same.connectionId, rid: same.rid, tmid: same.tmid } : null;
}

/**
 * Claim the round, find where it goes and hand it to the room's agent, which answers it from the
 * record or writes the one question to ask; an outcome where it stops.
 */
async function prepareRound(owed: OwedRound, now: Date): Promise<Prepared | Outcome> {
  const [question] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, owed.questionId))
    .limit(1);
  const step = question?.steps[owed.round - 1];
  if (!question || !step) return 'failed';

  const attempt = await claimRound(owed, now);
  if (attempt === null) return 'held';

  // the same question, still open on the same issue, was already asked: it waits in that thread
  const asked = await sameQuestionThread(
    owed.questionId,
    owed.projectId,
    owed.issueId,
    step.prompt,
  );
  if (
    asked &&
    (await registerThread({ questionId: owed.questionId }, asked, db, { shared: true }))
  ) {
    await settle(owed, { status: 'delivered' }, now);
    await resolveUndeliverableAlert(owed.questionId);
    return 'delivered';
  }

  const issueKey = owed.issueId
    ? ((await issueDisplayIds([owed.issueId])).get(owed.issueId) ?? null)
    : null;
  const round = {
    issueKey,
    step,
    parkDeadlineAt: question.parkDeadlineAt ?? null,
    askedBy: question.origin?.kind === 'conversation' ? question.origin.askedByLabel : null,
  };
  // a project question goes to the project's channel agent where it has one, never into its rooms
  if (!question.origin) {
    const handed = await channelAgentQuestions({
      questionId: owed.questionId,
      projectId: owed.projectId,
      round: step.round,
      facts: roundFacts(round),
      record: await questionRecord(owed.questionId),
    });
    if (handed === 'handed') {
      await settle(owed, { status: 'delivered' }, now);
      await resolveUndeliverableAlert(owed.questionId);
      return 'delivered';
    }
    if (handed !== 'none') return refuse(owed, handed.refused, now);
  }

  const destination = await resolveQuestionDestination({
    questionId: owed.questionId,
    projectId: owed.projectId,
    origin: question.origin ?? null,
    step,
  });
  if (destination.kind === 'unresolvable') return refuse(owed, destination.reason, now);

  const auth = await resolveRoomPostAuth(destination.connectionId, {
    source: 'rocketchat.question-delivery',
    questionId: owed.questionId,
  });
  if (!auth) return noteFailure(owed, attempt, 'the connection carries no usable credentials', now);
  const namespace = namespaceFromServerUrl(auth.serverUrl);
  const replyLanguage = namespace
    ? await roomLanguageOf('rocketchat', `${namespace} ${destination.rid}`)
    : null;

  const botName = liveConnectionFor(destination.connectionId)?.username ?? undefined;
  // the room's agent answers it from the record or asks it in its own words; core composes no line (ISS-857, ISS-873)
  const spoken = await agentAsks({
    projectId: owed.projectId,
    botName,
    questionId: owed.questionId,
    replyLanguage,
    round,
  }).catch((err: unknown): Spoken => ({ kind: 'error', reason: messageOf(err) }));
  if (spoken.kind === 'answered') {
    await settle(owed, { status: 'delivered' }, now);
    await resolveUndeliverableAlert(owed.questionId);
    return 'delivered';
  }
  if (spoken.kind === 'spoken') {
    return { attempt, destination, proven: spoken.message, auth, botName };
  }
  logger.error(
    { questionId: owed.questionId, round: owed.round, kind: spoken.kind, reason: spoken.reason },
    'rocketchat.question-delivery: the room agent did not ask the round; nothing posted',
  );
  return noteFailure(
    owed,
    attempt,
    `the room's agent did not ask it (${spoken.kind}): ${spoken.reason}`,
    now,
  );
}

/**
 * The room's thread for today's questions: the one standing, or one opened now under the agent's
 * own opening line. Null, with why, where the agent wrote none.
 */
async function threadOfTheDay(
  owed: OwedRound,
  { destination, auth, botName }: Prepared,
  now: Date,
): Promise<{ tmid: string } | { failed: string }> {
  const room = { connectionId: destination.connectionId, rid: destination.rid };
  const day = utcDayOf(now);
  const standing = await dailyThread(room, day);
  if (standing) return { tmid: standing };
  const namespace = namespaceFromServerUrl(auth.serverUrl);
  const opener = await agentOpensDay({
    projectId: owed.projectId,
    botName,
    replyLanguage: namespace
      ? await roomLanguageOf('rocketchat', `${namespace} ${room.rid}`)
      : null,
  }).catch((err: unknown): Spoken => ({ kind: 'error', reason: messageOf(err) }));
  if (opener.kind !== 'spoken') {
    return {
      failed: `the room's agent wrote no line to open today's thread for questions (${opener.kind}${'reason' in opener ? `: ${opener.reason}` : ''}), and a question is never asked at the room's top level`,
    };
  }
  const root = await sendFixedReply(
    { kind: 'rest', auth, rid: room.rid },
    opener.message.text,
    opener.message,
  );
  if (!root.messageId) {
    return { failed: "the post opening today's thread named no message id" };
  }
  return { tmid: await keepDailyThread(room, day, root.messageId) };
}

/** Post the agent's ask into its room and record the thread it now lives in. */
async function postRound(owed: OwedRound, prepared: Prepared, now: Date): Promise<Outcome> {
  const { attempt, destination, proven, auth } = prepared;
  const { connectionId, rid } = destination;
  // never at the room's top level: the thread it was raised in, or the room's thread of the day
  let tmid = destination.tmid;
  let shared = false;
  if (!tmid && !destination.direct) {
    const day = await threadOfTheDay(owed, prepared, now).catch(
      (err: unknown) => ({ failed: messageOf(err) }) as const,
    );
    if ('failed' in day) return noteFailure(owed, attempt, day.failed, now);
    tmid = day.tmid;
    shared = true;
  }
  if (destination.takeAnchor && tmid) {
    const took = await registerThread({ questionId: owed.questionId }, { connectionId, rid, tmid });
    if (!took) {
      return refuse(
        owed,
        `the message this question was raised against (${tmid}) is already another thread's root, so this round cannot be hung under it`,
        now,
      );
    }
  }

  let receipt: { messageId: string | null };
  try {
    receipt = await sendFixedReply(
      { kind: 'rest', auth, rid, ...(tmid ? { tmid } : {}) },
      proven.text,
      proven,
    );
  } catch (err) {
    await releaseTakenAnchor(destination, owed.questionId);
    logger.error(
      { err, questionId: owed.questionId, round: owed.round, rid },
      'rocketchat.question-delivery: posting the round failed',
    );
    if (isUnreachableRoom(err)) {
      return refuse(
        owed,
        `this bot can no longer post in room ${rid}, which is where this question was asked`,
        now,
      );
    }
    return noteFailure(owed, attempt, messageOf(err), now);
  }

  const thread = tmid ?? receipt.messageId;
  if (!thread) {
    return noteFailure(
      owed,
      attempt,
      'the post named no message id, so no thread can be registered',
      now,
    );
  }
  try {
    await registerThread({ questionId: owed.questionId }, { connectionId, rid, tmid: thread }, db, {
      shared,
    });
    await settle(owed, { status: 'delivered' }, now);
    await resolveUndeliverableAlert(owed.questionId);
    return 'delivered';
  } catch (err) {
    logger.error(
      { err, questionId: owed.questionId, round: owed.round, rid },
      'rocketchat.question-delivery: the round was posted and recording it failed',
    );
    return noteFailure(owed, attempt, messageOf(err), now);
  }
}

/** Settle this round undeliverable, tell the operator once, and post nothing anywhere. */
async function refuse(owed: OwedRound, reason: string, now: Date): Promise<'undeliverable'> {
  await settle(owed, { status: 'undeliverable', lastError: reason }, now);
  await reportUndeliverable(owed, owed.wasUndeliverable, reason);
  return 'undeliverable';
}

/** Give back an anchor this attempt took, and only one this attempt took. */
async function releaseTakenAnchor(
  destination: { takeAnchor: boolean; connectionId: string; rid: string; tmid: string | null },
  questionId: string,
): Promise<void> {
  if (!destination.takeAnchor || !destination.tmid) return;
  await releaseQuestionThread(questionId, {
    connectionId: destination.connectionId,
    rid: destination.rid,
    tmid: destination.tmid,
  });
}

interface QuestionDrainResult {
  owed: number;
  delivered: number;
  failed: number;
  undeliverable: number;
  /** Rounds another core instance was already posting. */
  held: number;
}

export async function drainQuestionDeliveries(
  clock: Date | (() => Date) = () => new Date(),
): Promise<QuestionDrainResult> {
  const at = typeof clock === 'function' ? clock : (): Date => clock;
  await clearWebDecidedAlerts();
  const owed = await owedRounds(at());
  const result: QuestionDrainResult = {
    owed: owed.length,
    delivered: 0,
    failed: 0,
    undeliverable: 0,
    held: 0,
  };
  for (const round of owed) {
    const outcome = await deliverOwedRound(round, at());
    result[outcome] += 1;
  }
  return result;
}
