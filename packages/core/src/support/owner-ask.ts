// A channel agent's question to the owner, through the channel (REQ-77 BC-12). The agent asks in a
// thread; the owner's next message in that thread, by the id the chat server signed, is the answer.
// It reaches the asking session as its next message (marked as the answer to that question), and the
// issue the question named, where one was named, as a note carrying the owner's own words; and, where
// the agent asked on a master's behalf, the Forge question it named (ISS-871): recorded as that
// question's answer, as the owner's linked Forge account, through the questions door (`answerAs`),
// whose `question.answered` wakes the master who asked. Nobody
// else's message answers it, whatever it says: who wrote it is the server's word, never the text's.
// Both halves are `routed` actions of the thread, so no state lives anywhere the record does not.

import { and, asc, eq, inArray } from 'drizzle-orm';
import { resolveSpeaker } from '../assistant/index.js';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { agentQuestions, isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { answerAs } from '../questions/index.js';
import { granters, grantsOf, readersOf, supportConfigOf } from './grants.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { dayThreadFor } from './question-task.js';
import { threadLink } from './record.js';
import { isQuestionThread } from './rules.js';
import { screenForThread } from './screen.js';
import { type ActionRow, insertAction, type RoomRow, threadMembers } from './store.js';
import { postInThread, roomAuth, scrubbedForRoom, TOP_LEVEL } from './thread.js';

const ASK = 'ask_owner';
const ANSWER = 'owner_answer';

interface AskInput {
  question: string;
  /** The issue key the answer is also written on. */
  record: string | null;
  issueId: string | null;
  /** The master's Forge question the answer is recorded on (ISS-871); absent on an older ask. */
  questionId?: string | null;
  /** The parked question's thread it was handed in (ISS-873), where it was asked in the day's thread. */
  handedIn?: string;
}

/** Why a Forge question cannot take the owner's answer through this channel, or null. */
async function questionRefusal(projectId: string, questionId: string): Promise<string | null> {
  const [q] = await db
    .select({
      projectId: agentQuestions.projectId,
      status: agentQuestions.status,
      batchId: agentQuestions.batchId,
    })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (!q || q.projectId !== projectId) return `${questionId} names no question of this project`;
  if (q.status !== 'open')
    return `question ${questionId} is ${q.status}, and only an open one takes an answer`;
  if (q.batchId)
    return `question ${questionId} is an item of a questionnaire, answered with its batch`;
  return null;
}

/** The issue of the project a key such as `ISS-12` names, or null. */
async function issueOfKey(projectId: string, key: string): Promise<{ id: string } | null> {
  const seq = Number(key.replace(/^\D+/, ''));
  if (!Number.isSafeInteger(seq)) return null;
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, seq)))
    .limit(1);
  return row ?? null;
}

/** The username the owner writes under, as Forge saw it on one of their messages in this project. */
async function ownerUsername(projectId: string, ownerId: string): Promise<string | null> {
  const [row] = await db
    .select({ label: supportActions.actorLabel })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.projectId, projectId),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKey, ownerId),
      ),
    )
    .orderBy(asc(supportActions.createdAt))
    .limit(1);
  return row?.label ?? null;
}

/**
 * A project's question reaches the owner only in the room the binding names for them (ISS-872), in a
 * thread a member wrote in: never in a room the product's users read, another group, or at top level.
 */
async function ownerRoomRefusal(
  room: RoomRow,
  ownerRoom: string | null,
  thread: string,
): Promise<Outcome<never> | null> {
  if (!ownerRoom) {
    return no(
      'SUPPORT_NOT_THE_OWNER_ROOM',
      '/action',
      `this agent's binding names no owner's room, so nobody was asked: a question for the owner goes only to the group the binding names as \`agent.ownerRoom\`; ${await granters(room.projectId)}`,
    );
  }
  if (room.rid !== ownerRoom) {
    const readers = (await readersOf(room)) === 'users' ? "the product's users" : 'the team';
    return no(
      'SUPPORT_NOT_THE_OWNER_ROOM',
      '/action',
      `${room.rid} is read by ${readers}, and a question for the owner is asked only in the owner's room ${ownerRoom}, in a thread there, in plain words; nothing was asked`,
    );
  }
  if (thread === TOP_LEVEL) {
    return no(
      'SUPPORT_NOT_THE_OWNER_ROOM',
      '/thread',
      `a question for the owner is asked in a thread of ${ownerRoom} a member wrote in, never at its top level; nothing was asked`,
    );
  }
  return null;
}

/** An asker's thread: a member wrote in it, never the top-level post of an announcement. */
async function askersThread(
  room: RoomRow,
  thread: string,
): Promise<Outcome<{ thread: string; forgeQuestion?: string }>> {
  const known = (await threadMembers(room.id, thread)).length
    ? await knownThread(room, thread)
    : null;
  return known ? { ok: true, value: { thread } } : threadUnknown(thread);
}

/**
 * Ask the owner the binding names, in a thread of the owner's room (ISS-872). Refused by name, nothing posted,
 * when the room is not a channel agent's, the binding names no owner, the thread is unknown, or the
 * issue the answer should be written on is not one of this project.
 */
export async function askOwner(
  room: RoomRow,
  request: {
    thread: string;
    question: string;
    record?: string | undefined;
    forgeQuestion?: string | undefined;
    opener?: string | undefined;
  },
): Promise<
  Outcome<{
    messageId: string | null;
    mentioned: boolean;
    record: string | null;
    forgeQuestion: string | null;
  }>
> {
  if (room.kind !== 'agent') {
    return no(
      'SUPPORT_OWNER_NOT_NAMED',
      '/action',
      "ask_owner is a channel agent's act: this room's binding carries no `agent` block, so it names no owner to ask",
    );
  }
  const config = await supportConfigOf(room);
  const owner = grantsOf(config).owner;
  if (!owner) {
    return no(
      'SUPPORT_OWNER_NOT_NAMED',
      '/action',
      `this agent's binding names no owner, so nobody was asked: name the owner's Rocket.Chat user id in its grant; ${await granters(room.projectId)}`,
    );
  }
  const notOwnerRoom = await ownerRoomRefusal(room, config?.ownerRoom ?? null, request.thread);
  if (notOwnerRoom) return notOwnerRoom;
  const handed = isQuestionThread(request.thread);
  if (handed) {
    // screened before the day's thread is opened for it, so a refused question opens nothing
    const first = await screenForThread(
      room,
      null,
      request.thread,
      await scrubbedForRoom(room, request.question),
      'operations-reply',
      ASK,
    );
    if (!first.ok) return first;
  }
  // a parked question handed to this agent is asked in the owner's room's thread of the day (ISS-873)
  const where = handed
    ? await dayThreadFor(room, request)
    : await askersThread(room, request.thread);
  if (!where.ok) return where;
  const input = {
    ...request,
    thread: where.value.thread,
    forgeQuestion: where.value.forgeQuestion ?? request.forgeQuestion,
  };
  const conversationId = await knownThread(room, input.thread);
  const issue = input.record ? await issueOfKey(room.projectId, input.record) : null;
  if (input.record && !issue) {
    return no(
      'SUPPORT_OWNER_RECORD_UNKNOWN',
      '/record',
      `${input.record} names no issue of this project, so the answer would be written nowhere; nothing was asked`,
    );
  }
  const notAnswerable = input.forgeQuestion
    ? await questionRefusal(room.projectId, input.forgeQuestion)
    : null;
  if (notAnswerable) {
    return no(
      'SUPPORT_OWNER_QUESTION_UNKNOWN',
      '/forgeQuestion',
      `${notAnswerable}, so the owner's answer would be recorded nowhere; nothing was asked`,
    );
  }
  const username = await ownerUsername(room.projectId, owner);
  // the question is the agent's own words; the owner's next message in the thread counts as the
  // answer by the kernel rule (`settleOwnerAnswer`), and the agent says so itself if it needs to
  const text = await scrubbedForRoom(room, `${username ? `@${username} ` : ''}${input.question}`);
  const admitted = await screenForThread(
    room,
    conversationId,
    input.thread,
    text,
    'operations-reply',
    ASK,
  );
  if (!admitted.ok) return admitted;
  const posted = await postInThread({
    room,
    thread: input.thread,
    text: admitted.value.text,
    proof: admitted.value.proof,
  });
  const asked: AskInput = {
    question: input.question,
    record: input.record ?? null,
    issueId: issue?.id ?? null,
    questionId: input.forgeQuestion ?? null,
    ...(handed ? { handedIn: request.thread } : {}),
  };
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: input.thread,
    kind: 'routed',
    actorKind: 'session',
    tool: ASK,
    input: asked,
    output: { owner, mentioned: username !== null },
    externalId: posted.messageId,
  });
  return {
    ok: true,
    value: {
      messageId: posted.messageId,
      mentioned: username !== null,
      record: asked.record,
      forgeQuestion: asked.questionId ?? null,
    },
  };
}

/** The questions a thread asked the owner that nothing has answered yet, oldest first. */
async function openAsks(room: RoomRow, thread: string): Promise<ActionRow[]> {
  const rows = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'routed'),
        inArray(supportActions.tool, [ASK, ANSWER, 'answer_question']),
      ),
    )
    .orderBy(asc(supportActions.createdAt));
  const answered = new Set(
    rows.filter((r) => r.tool === ANSWER).map((r) => (r.input as { ask?: string }).ask),
  );
  // a handed question the agent answered itself (ISS-873), wherever it was asked
  const settled = new Set(
    rows
      .filter((r) => r.tool === 'answer_question')
      .map((r) => (r.input as { forgeQuestion?: string }).forgeQuestion),
  );
  return rows.filter(
    (r) =>
      r.tool === ASK &&
      r.thread === thread &&
      !answered.has(r.id) &&
      !settled.has((r.input as AskInput).questionId ?? undefined),
  );
}

/**
 * A message of the owner's in a thread answers every question that thread still holds for them:
 * each is marked answered by it, and written on the issue it named. True when it answered one, so
 * the session is handed it whatever the room's answering mode. `author` is the chat server's word.
 */
export async function settleOwnerAnswer(input: {
  room: RoomRow;
  thread: string;
  message: { id: string; text: string };
  author: { key: string; label: string | null };
}): Promise<boolean> {
  const { room, thread, message, author } = input;
  if (room.kind !== 'agent') return false;
  const owner = grantsOf(await supportConfigOf(room)).owner;
  if (!owner || author.key !== owner) return false;
  let answered = false;
  const open = await openAsks(room, thread);
  // the day's thread may hold several handed questions: whose answer this is, the agent says (ISS-873)
  const handedAsks = open.filter((a) => (a.input as AskInput).handedIn);
  if (handedAsks.length > 1) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: handedAsks[0]?.conversationId ?? null,
      thread,
      kind: 'message_in',
      actorKind: 'core',
      input: {
        note: `The owner's message ${message.id} is in today's questions thread, where ${handedAsks.length} questions wait, so it was recorded on none. Record the one it answers with support.answer_question { thread, message: "${message.id}" }, naming that question's thread (${handedAsks.map((a) => (a.input as AskInput).handedIn).join(', ')}); where it is unclear, ask the owner in this thread which one they mean.`,
      },
      externalId: `owner-answer-several:${message.id}`,
    });
    return true;
  }
  for (const ask of open) {
    const asked = ask.input as AskInput;
    const marker = await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: ask.conversationId,
      thread,
      kind: 'routed',
      actorKind: 'core',
      tool: ANSWER,
      input: { ask: ask.id, message: message.id, question: asked.question, record: asked.record },
      externalId: `owner-answer:${ask.id}`,
    });
    if (!marker) continue;
    answered = true;
    if (asked.questionId) {
      await answerForgeQuestion(room, thread, ask, asked.questionId, message, author.key);
    }
    if (!asked.issueId) continue;
    await writeOnIssue(room, thread, asked, message.text).catch(async (err) => {
      logger.error(
        { err, roomId: room.id, ask: ask.id },
        'support: the owner answer was not written on its issue',
      );
      await insertAction({
        roomId: room.id,
        projectId: room.projectId,
        conversationId: ask.conversationId,
        thread,
        kind: 'refused',
        actorKind: 'core',
        tool: ANSWER,
        output: { code: 'issue_note_failed', record: asked.record },
      });
    });
  }
  return answered;
}

/** What a Forge question's round takes from the owner's words: the text, or the option they name. */
function answerOfWords(
  step: QuestionStep,
  words: string,
): { kind: 'text'; text: string } | { kind: 'option'; optionId: string } | null {
  if (!isChoiceStep(step)) return { kind: 'text', text: words };
  const said = words.trim().toLowerCase();
  const option = step.options.find(
    (o) => o.id.toLowerCase() === said || o.label.toLowerCase() === said,
  );
  return option ? { kind: 'option', optionId: option.id } : null;
}

/**
 * Record the owner's answer on the Forge question the ask named, as the owner's linked Forge account,
 * through the questions door: its `question.answered` wakes the master who asked. Where it cannot be
 * recorded, the refusal is kept on the thread and the session is told why, to say in its own words.
 */
async function answerForgeQuestion(
  room: RoomRow,
  thread: string,
  ask: ActionRow,
  questionId: string,
  message: { id: string; text: string },
  ownerKey: string,
): Promise<void> {
  const why = await (async (): Promise<string | null> => {
    const { namespace } = await roomAuth(room);
    const owner = await resolveSpeaker({ source: 'rocketchat', namespace, externalId: ownerKey });
    if (!owner.linked) {
      return "the owner's chat account is linked to no Forge account, so nobody can be recorded as answering; ask them to link it (support.link) and answer again";
    }
    const [q] = await db
      .select({ status: agentQuestions.status, steps: agentQuestions.steps })
      .from(agentQuestions)
      .where(eq(agentQuestions.id, questionId))
      .limit(1);
    const step = q?.steps.at(-1);
    if (q?.status !== 'open' || !step) return `the question is ${q?.status ?? 'gone'} now`;
    const answer = answerOfWords(step, message.text);
    if (!answer) {
      const options = isChoiceStep(step) ? step.options.map((o) => o.label).join(' | ') : '';
      return `the question is a choice, and the owner's words name none of its options (${options}); ask them to answer with one`;
    }
    try {
      await answerAs({
        questionId,
        answer,
        round: step.round,
        userId: owner.userId,
        via: 'assistant',
      });
      return null;
    } catch (err) {
      if (isRefusal(err)) return err.refusals.map((r) => r.detail).join('; ');
      logger.error(
        { err, roomId: room.id, questionId },
        'support: the owner answer was not recorded',
      );
      return `recording it failed (${err instanceof Error ? err.message : String(err)})`;
    }
  })();
  if (why === null) return;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: ask.conversationId,
    thread,
    kind: 'refused',
    actorKind: 'core',
    tool: ANSWER,
    output: { code: 'question_answer_unrecorded', questionId, why },
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: ask.conversationId,
    thread,
    kind: 'message_in',
    actorKind: 'core',
    input: {
      note: `The owner's answer (message ${message.id}) was not recorded on Forge question ${questionId}: ${why}. The master who asked still waits.`,
    },
    externalId: `owner-answer-unrecorded:${ask.id}:${message.id}`,
  });
}

async function writeOnIssue(
  room: RoomRow,
  thread: string,
  asked: AskInput,
  answer: string,
): Promise<void> {
  const link = await threadLink(room, thread);
  await postIssueNotice({
    issueId: asked.issueId as string,
    authorId: room.principalUserId,
    authorsWords: true,
    intent: 'note',
    body: await scrubbedForRoom(
      room,
      `The owner answered in the channel (${link}).\n\nAsked: ${asked.question}\n\nAnswer: ${answer}`,
    ),
  });
}

/** The question each message of these rows answers, by message id, for the header the session reads. */
export async function answersOf(
  room: RoomRow,
  rows: readonly ActionRow[],
): Promise<Map<string, string>> {
  const ids = rows.flatMap((r) => (r.externalId ? [r.externalId] : []));
  if (ids.length === 0) return new Map();
  const markers = await db
    .select({ input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'routed'),
        eq(supportActions.tool, ANSWER),
      ),
    );
  const out = new Map<string, string>();
  for (const m of markers) {
    const i = m.input as { message?: string; question?: string };
    if (i.message && i.question && ids.includes(i.message)) out.set(i.message, i.question);
  }
  return out;
}
