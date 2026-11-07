// A run's or a master's parked question, handed to the project's channel agent as a task (ISS-873;
// owner ruling agent-is-the-voice). Core posts nothing: it writes the round and what the record holds
// about it into the owner's room's record, under a thread no member wrote in, and hands it to the
// agent. The agent answers it from the record (`answer_question` with `source`), and nothing is
// posted; or, only where the owner is truly needed, asks once with `ask_owner` from that thread,
// which posts inside the owner's room's one thread for the day's questions. The owner's message
// there, or in any thread, is cited back with `answer_question` and `message`, and recorded as theirs.

import type { SupportAnswerQuestionRequest } from '@forge/contracts/support-channel';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { answerFromRecord, type ChannelAgentRound, resolveSpeaker } from '../assistant/index.js';
import { db } from '../db/client.js';
import { agentQuestions, isChoiceStep } from '../db/schema-questions.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { answerAs } from '../questions/index.js';
import { deliverWaiting } from './dispatch.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { keepOwnerAnswer, ownerSetupStep } from './kept-answers.js';
import { no, type Outcome } from './outcome.js';
import { ownerOwedQuestion } from './owner-owed.js';
import type { Refusal } from './refusals.js';
import { heldRoomsOfProject } from './rooms.js';
import { questionThreadOf } from './rules.js';
import { screenForThread } from './screen.js';
import { type ActionRow, insertAction, type RoomRow } from './store.js';
import { postForTopLevel, roomAuth, scrubbedForRoom, TOP_LEVEL } from './thread.js';

const ANSWER = 'answer_question';
const ASK = 'ask_owner';
const OWNER_ANSWER = 'owner_answer';
/** The owner's room's one thread for the day's questions, kept as an `operation`. */
const DAY_THREAD = 'questions_day';

/** The questions door's own refusals (`QUESTION_NOT_OPEN`, …), passed on to the agent by name. */
const passedOn = <T>(
  refusals: readonly { code: string; path: string; detail: string }[],
): Outcome<T> => ({
  ok: false,
  refusals: refusals as unknown as Refusal[],
});

/** The owner's room of the project's channel agent; why there is none; or null with no channel agent. */
async function ownerRoomOf(projectId: string): Promise<RoomRow | string | null> {
  const rooms = (await heldRoomsOfProject(projectId)).filter((r) => r.kind === 'agent');
  if (rooms.length === 0) return null;
  for (const room of rooms) {
    const ownerRoom = (await supportConfigOf(room))?.ownerRoom;
    const found = ownerRoom ? rooms.find((r) => r.rid === ownerRoom) : undefined;
    if (found) return found;
  }
  return "this project's channel agent binding names no owner's room (`agent.ownerRoom`), so its parked question is asked in no group, and never in another: a project admin names the owner's room on the binding, and the next sweep hands it on. It waits on its issue page meanwhile";
}

/** The task, as the agent reads it: what to do first, the round, and the record about it. */
function taskNote(thread: string, r: ChannelAgentRound): string {
  return [
    `A run is parked on a question (Forge question ${r.questionId}, round ${r.round}). First answer it from the record below, or read more with support.issues and support.requirements: where the record settles it, call support.answer_question { thread: "${thread}", source, option | answer } and post nothing. Only if the owner is truly needed, ask once with support.ask_owner { thread: "${thread}", question, forgeQuestion: "${r.questionId}" }, in the persona's language and plain words with no code: it goes into today's questions thread of the owner's room. Post this question nowhere else.`,
    r.facts,
    `The record: ${JSON.stringify(r.record)}`,
  ].join('\n\n');
}

/**
 * Hand a round to the project's channel agent, once: `none` where the project has none, or why it
 * can be handed nowhere.
 */
export async function handQuestionToChannelAgent(
  r: ChannelAgentRound,
): Promise<'none' | 'handed' | { refused: string }> {
  const room = await ownerRoomOf(r.projectId);
  if (room === null) return 'none';
  if (typeof room === 'string') return { refused: room };
  const thread = questionThreadOf(r.questionId, r.round);
  // unique per room and thread: a round handed before is not handed again
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread,
    kind: 'message_in',
    actorKind: 'core',
    input: { note: taskNote(thread, r), forgeQuestion: r.questionId, round: r.round },
    externalId: thread,
  });
  await deliverWaiting(room.id).catch((err) =>
    logger.error({ err, roomId: room.id, thread }, 'support: a parked question was not handed on'),
  );
  return 'handed';
}

/** The question a `question-` thread of this room was handed, or null. */
export async function handedQuestion(
  room: RoomRow,
  thread: string,
): Promise<{ questionId: string; round: number } | null> {
  const [row] = await db
    .select({ input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.thread, thread),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'core'),
      ),
    )
    .orderBy(asc(supportActions.createdAt))
    .limit(1);
  const input = row?.input as { forgeQuestion?: unknown; round?: unknown } | null | undefined;
  return typeof input?.forgeQuestion === 'string' && typeof input.round === 'number'
    ? { questionId: input.forgeQuestion, round: input.round }
    : null;
}

export const questionUnknown = <T>(thread: string): Outcome<T> =>
  no(
    'SUPPORT_QUESTION_UNKNOWN',
    '/thread',
    `${thread} names no parked question handed to this group; answer the question thread you were handed, or name an open question you were shown as \`forgeQuestion\`. Nothing was recorded or posted.`,
  );

/** The owner's message in this room, by the id the chat server signed, or null. */
async function ownerMessage(room: RoomRow, owner: string, id: string): Promise<ActionRow | null> {
  const [row] = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
        eq(supportActions.actorKey, owner),
        eq(supportActions.externalId, id),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Record the owner's cited message as their answer, as the Forge account his chat account is. Where
 * it is none yet, the answer is kept and recorded once it is (ISS-976), and the refusal names who
 * owes that step: never him.
 */
async function answerAsOwner(
  room: RoomRow,
  handed: { questionId: string; round: number },
  input: SupportAnswerQuestionRequest & { message: string },
): Promise<Outcome<{ recorded: true }>> {
  const owner = grantsOf(await supportConfigOf(room)).owner;
  const said = owner ? await ownerMessage(room, owner, input.message) : null;
  if (!owner || !said) {
    return no(
      'SUPPORT_ANSWER_NOT_THE_OWNER',
      '/message',
      `${input.message} is no message the owner this binding names wrote in this group; cite the owner's own message that answers it. Nothing was recorded.`,
    );
  }
  const [q] = await db
    .select({ steps: agentQuestions.steps, projectId: agentQuestions.projectId })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, handed.questionId))
    .limit(1);
  const step = q?.steps.at(-1);
  const words = ((said.input as { text?: unknown } | null)?.text as string | undefined) ?? '';
  const answer =
    step && isChoiceStep(step)
      ? step.options.some((o) => o.id === input.option)
        ? { kind: 'option' as const, optionId: input.option as string }
        : null
      : { kind: 'text' as const, text: words.trim() };
  if (!answer || (answer.kind === 'text' && !answer.text)) {
    return no(
      'SUPPORT_ANSWER_SOURCE',
      '/option',
      step && isChoiceStep(step)
        ? `this question is a choice: pass \`option\`, the id of the option the owner's words pick (${step.options.map((o) => o.id).join(', ')}). Nothing was recorded.`
        : "the owner's message carries no words to record. Nothing was recorded.",
    );
  }
  // the account is resolved where the answer is recorded: a naming holds in its own project alone
  const questionProject = q?.projectId ?? room.projectId;
  const { namespace } = await roomAuth(room);
  const speaker = await resolveSpeaker(
    { source: 'rocketchat', namespace, externalId: owner },
    questionProject,
  );
  if (!speaker.linked) {
    if (q) {
      await keepOwnerAnswer(room, input.thread, {
        questionId: handed.questionId,
        questionProjectId: questionProject,
        round: handed.round,
        message: input.message,
        ownerKey: owner,
        answer,
      });
    }
    return no('SUPPORT_ANSWER_NOT_THE_OWNER', '/message', await ownerSetupStep(questionProject));
  }
  try {
    await answerAs({
      questionId: handed.questionId,
      answer,
      round: handed.round,
      userId: speaker.userId,
      via: 'assistant',
    });
  } catch (err) {
    if (isRefusal(err))
      return passedOn(
        err.refusals.map((r) => ({ code: r.code, path: r.path ?? '', detail: r.detail })),
      );
    throw err;
  }
  return { ok: true, value: { recorded: true } };
}

/**
 * A channel agent answers the question it was handed: from the record, citing `source`, or with the
 * owner's message `message`. A person-owed question it was shown, named as `forgeQuestion`, takes the
 * owner's message from any thread of the group (ISS-916). Nothing is posted either way.
 */
export async function answerHandedQuestion(
  room: RoomRow,
  input: SupportAnswerQuestionRequest,
): Promise<Outcome<{ recorded: true }>> {
  if (input.forgeQuestion && !input.message) {
    return no(
      'SUPPORT_ANSWER_SOURCE',
      '/message',
      "a question named by `forgeQuestion` is answered only by the owner's own words: cite his `message`. Nothing was recorded.",
    );
  }
  // a person-owed question named by id takes the owner's message from any thread (ISS-916)
  const owed = input.forgeQuestion ? await ownerOwedQuestion(room, input.forgeQuestion) : null;
  if (owed && !owed.ok) return owed;
  const handed = owed ? owed.value : await handedQuestion(room, input.thread);
  if (!handed) return questionUnknown(input.thread);
  if (Boolean(input.source) === Boolean(input.message)) {
    return no(
      'SUPPORT_ANSWER_SOURCE',
      '/source',
      "name where the answer is, one of the two: `source` (where in the record) or `message` (the owner's message that answers it). Nothing was recorded.",
    );
  }
  const out = input.message
    ? await answerAsOwner(room, handed, { ...input, message: input.message })
    : await answerFromRecord({
        questionId: handed.questionId,
        projectId: room.projectId,
        round: handed.round,
        args: { source: input.source, option: input.option, answer: input.answer },
      }).then(
        (r): Outcome<{ recorded: true }> =>
          r.ok ? { ok: true, value: { recorded: true } } : passedOn(r.refusals),
      );
  if (!out.ok) return out;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: input.thread,
    kind: 'routed',
    actorKind: 'session',
    tool: ANSWER,
    input: { ...input, forgeQuestion: handed.questionId },
  });
  return out;
}

/** This room's thread for the UTC day's questions, by its root's message id, or null. */
async function standingDayThread(room: RoomRow, day: string): Promise<string | null> {
  const [row] = await db
    .select({ thread: supportActions.thread })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'operation'),
        eq(supportActions.tool, DAY_THREAD),
        eq(supportActions.externalId, `${DAY_THREAD}:${day}`),
      ),
    )
    .limit(1);
  return row?.thread ?? null;
}

/**
 * Where a handed question is asked: inside the owner's room's one thread for the day's questions,
 * opened by the agent's own `opener` where none is open yet — never at the top level, and never
 * twice for one question (ISS-873).
 */
export async function dayThreadFor(
  room: RoomRow,
  input: { thread: string; forgeQuestion?: string | undefined; opener?: string | undefined },
): Promise<Outcome<{ thread: string; forgeQuestion: string }>> {
  const handed = await handedQuestion(room, input.thread);
  if (!handed) return questionUnknown(input.thread);
  const waiting = (await asksOfQuestion(room, handed.questionId)).find((a) => !a.answered);
  if (waiting) {
    return no(
      'SUPPORT_OWNER_ALREADY_ASKED',
      '/thread',
      `this question was already asked in the owner's room, in thread ${waiting.thread}; the owner's answer there reaches you. Nothing was posted.`,
    );
  }
  const day = new Date().toISOString().slice(0, 10);
  const standing = await standingDayThread(room, day);
  if (standing) return { ok: true, value: { thread: standing, forgeQuestion: handed.questionId } };
  if (!input.opener) {
    return no(
      'SUPPORT_DAY_THREAD_OPENER',
      '/opener',
      `no thread for today's questions is open in ${room.rid} yet: pass \`opener\`, one short line in the persona's language that opens it; your question goes inside it, never at the top level. Nothing was posted.`,
    );
  }
  const opener = await scrubbedForRoom(room, input.opener);
  const admitted = await screenForThread(room, null, TOP_LEVEL, opener, 'operations-reply', ASK);
  if (!admitted.ok) return admitted;
  // a shared operations room opens the day inside the project's own thread, which is then the
  // day's thread: a chat thread does not nest (ISS-933)
  const out = await postForTopLevel({
    room,
    text: admitted.value.text,
    proof: admitted.value.proof,
  });
  if (!out.ok) return out;
  const root = out.value;
  const dayThread = root.thread ?? root.messageId;
  if (!dayThread) {
    throw new Error(
      `support: the line opening today's questions thread in ${room.rid} named no message id`,
    );
  }
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: root.conversationId,
    thread: dayThread,
    kind: 'operation',
    actorKind: 'session',
    tool: DAY_THREAD,
    input: { day, text: opener },
    externalId: `${DAY_THREAD}:${day}`,
  });
  return { ok: true, value: { thread: dayThread, forgeQuestion: handed.questionId } };
}

/** The asks this room put to the owner for one Forge question, and whether each was answered. */
async function asksOfQuestion(
  room: RoomRow,
  questionId: string,
): Promise<{ thread: string; answered: boolean }[]> {
  const rows = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'routed'),
        inArray(supportActions.tool, [ASK, OWNER_ANSWER, ANSWER]),
      ),
    );
  const answeredAsks = new Set(
    rows.filter((r) => r.tool === OWNER_ANSWER).map((r) => (r.input as { ask?: string }).ask),
  );
  const answeredByAgent = rows.some(
    (r) =>
      r.tool === 'answer_question' &&
      (r.input as { forgeQuestion?: string }).forgeQuestion === questionId,
  );
  return rows
    .filter((r) => r.tool === ASK && (r.input as { questionId?: string }).questionId === questionId)
    .map((r) => ({ thread: r.thread, answered: answeredByAgent || answeredAsks.has(r.id) }));
}
