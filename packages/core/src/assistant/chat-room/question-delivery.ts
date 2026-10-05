// Carrying a parked run's question to a room, and remembering which thread it went to. The
// ledger of owed rounds and its operator alerts are `question-ledger.ts`.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { rocketchatQuestionDeliveries } from '../../db/schema-rocketchat.js';
import {
  registerThread,
  releaseQuestionThread,
  resolveRoomPostAuth,
  sendFixedReply,
} from '../../integrations/rocketchat/index.js';
import { issueDisplayIds } from '../../issues/index.js';
import { problemsOf } from '../../messaging/contract.js';
import { type ProvenMessage, screenForDoor } from '../../messaging/proven.js';
import { logger } from '../../observability/logger.js';
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
import { renderRound } from './question-render.js';

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
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Deliver one owed round. Never throws — a failure is a record, not an exception.
 */
async function deliverOwedRound(owed: OwedRound, now: Date = new Date()): Promise<Outcome> {
  const prepared = await prepareRound(owed, now);
  return typeof prepared === 'string' ? prepared : postRound(owed, prepared, now);
}

/** Claim the round, find where it goes and screen what it says; an outcome where it stops. */
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

  const destination = await resolveQuestionDestination({
    questionId: owed.questionId,
    projectId: owed.projectId,
    origin: question.origin ?? null,
    step,
  });
  if (destination.kind === 'unresolvable') return refuse(owed, destination.reason, now);

  const issueKey = owed.issueId
    ? ((await issueDisplayIds([owed.issueId])).get(owed.issueId) ?? null)
    : null;
  const screening = screenForDoor(
    'question-delivery',
    renderRound({
      issueKey,
      step,
      rounds: question.steps.length,
      parkDeadlineAt: question.parkDeadlineAt ?? null,
      askedBy: question.origin?.kind === 'conversation' ? question.origin.askedByLabel : null,
    }),
  );
  if (screening.ok) return { attempt, destination, proven: screening.proven };
  const problems = problemsOf(screening.verdict);
  logger.error(
    { questionId: owed.questionId, round: owed.round, problems },
    'rocketchat.question-delivery: the round was refused by the operator screen; not posted',
  );
  return noteFailure(owed, attempt, `screen refused the round: ${problems.join('; ')}`, now);
}

/** Post the screened round into its room and record the thread it now lives in. */
async function postRound(
  owed: OwedRound,
  { attempt, destination, proven }: Prepared,
  now: Date,
): Promise<Outcome> {
  const auth = await resolveRoomPostAuth(destination.connectionId, {
    source: 'rocketchat.question-delivery',
    questionId: owed.questionId,
  });
  if (!auth) return noteFailure(owed, attempt, 'the connection carries no usable credentials', now);

  const { connectionId, rid, tmid } = destination;
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
    await registerThread({ questionId: owed.questionId }, { connectionId, rid, tmid: thread });
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
