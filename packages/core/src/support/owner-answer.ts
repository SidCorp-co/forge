// The owner's answer to an ask posted in the project's technical channel (ISS-1246; REQ-77 BC-12):
// his reply there, by the id the chat server signed for its writer, reaches the asking session in the
// asker's thread, marked the answer to that question, and is written on the issue and the Forge
// question the ask named (ISS-871). Nobody else's message answers it, whatever it says.

import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { resolveSpeaker } from '../assistant/index.js';
import { postIssueNotice } from '../comments/index.js';
import { appendMessagesIn } from '../conversations/index.js';
import { db } from '../db/client.js';
import { agentQuestions, isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { answerAs } from '../questions/index.js';
import { deliverWaiting } from './dispatch.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { keepOwnerAnswer, ownerRoleGap, ownerSetupStep } from './kept-answers.js';
import { ASK, type AskedAt, type AskInput } from './owner-ask.js';
import { threadLink } from './record.js';
import { type ActionRow, insertAction, type RoomRow, roomById } from './store.js';
import { roomAuth, scrubbedForRoom } from './thread.js';

const ANSWER = 'owner_answer';
/**
 * An owed item the agent put to the owner (`owner-owed-raise.ts:raiseOwed`, ISS-1243 item 23): a post
 * in the technical channel waiting on his reply as an ask does, matched by the same rule. His reply
 * reaches the owed- thread as his message, and the agent settles it as him from there.
 */
const RAISE_OWED = 'raise_owed';

/** The asks and owed raises posted in a room of the technical channel his reply has not answered yet, oldest first. */
async function openAsksAt(rid: string): Promise<ActionRow[]> {
  const asks = await db
    .select()
    .from(supportActions)
    .where(
      and(
        or(
          and(eq(supportActions.kind, 'routed'), eq(supportActions.tool, ASK)),
          and(eq(supportActions.kind, 'operation'), eq(supportActions.tool, RAISE_OWED)),
        ),
        sql`${supportActions.output} ->> 'rid' = ${rid}`,
      ),
    )
    .orderBy(asc(supportActions.createdAt));
  if (asks.length === 0) return [];
  const rows = await db
    .select()
    .from(supportActions)
    .where(
      and(
        inArray(supportActions.roomId, [...new Set(asks.map((a) => a.roomId))]),
        eq(supportActions.kind, 'routed'),
        inArray(supportActions.tool, [ANSWER, 'answer_question']),
      ),
    );
  const answered = new Set(
    rows.filter((r) => r.tool === ANSWER).map((r) => (r.input as { ask?: string }).ask),
  );
  // a handed question the agent answered itself (ISS-873), wherever it was asked
  const settled = new Set(
    rows
      .filter((r) => r.tool === 'answer_question')
      .map((r) => `${r.roomId}:${(r.input as { forgeQuestion?: string }).forgeQuestion}`),
  );
  return asks.filter(
    (a) => !answered.has(a.id) && !settled.has(`${a.roomId}:${(a.input as AskInput).questionId}`),
  );
}

/**
 * The owner's message in a room of the project's technical channel, `rid`, in thread `thread` (null
 * at top level): the answer to the ask it replies to, or to the one ask waiting where it was written.
 * Where several wait and it replies to none, it answers none, and each asking session is told so.
 * True when it was taken so, and the room it was written in keeps it as context alone. `author` is
 * the chat server's word: anyone but the owner the asking room's binding names answers nothing.
 */
export async function settleOwnerAnswer(input: {
  rid: string;
  thread: string | null;
  message: { id: string; text: string; replyTo: string | null };
  author: { key: string; label: string | null };
}): Promise<boolean> {
  const { rid, thread, message, author } = input;
  const open = await openAsksAt(rid);
  if (open.length === 0) return false;
  // where it was written: the project's thread of the shared room, or the direct message itself
  const here = open.filter((a) => {
    const at = a.output as AskedAt;
    return at.channel === 'dm' || at.thread === thread;
  });
  const rooms = new Map<string, RoomRow>();
  const his: ActionRow[] = [];
  for (const ask of here) {
    const room = rooms.get(ask.roomId) ?? (await roomById(ask.roomId));
    if (!room) continue;
    rooms.set(room.id, room);
    if (grantsOf(await supportConfigOf(room)).owner === author.key) his.push(ask);
  }
  if (his.length === 0) return false;
  const named = his.filter((a) => {
    const line = (a.output as AskedAt).messageId;
    return line !== null && (line === message.replyTo || line === thread);
  });
  const answering = named.length > 0 ? named : his.length === 1 ? his : [];
  if (answering.length === 0) {
    await tellSeveralWait(rooms, his, message.id);
    return true;
  }
  for (const ask of answering) {
    const room = rooms.get(ask.roomId) as RoomRow;
    await answerAsk(room, ask, message, author);
    await deliverWaiting(room.id).catch((err) =>
      logger.error({ err, roomId: room.id }, "support: the owner's answer waits for the next turn"),
    );
  }
  return true;
}

/** The owner wrote where several of the asks wait, replying to none: recorded on none, said to each. */
async function tellSeveralWait(
  rooms: ReadonlyMap<string, RoomRow>,
  asks: readonly ActionRow[],
  message: string,
): Promise<void> {
  const questions = asks
    .map((a) => `"${(a.input as AskInput).question ?? `the item put to him from ${a.thread}`}"`)
    .join('; ');
  for (const ask of asks) {
    const room = rooms.get(ask.roomId) as RoomRow;
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: ask.conversationId,
      thread: ask.thread,
      kind: 'message_in',
      actorKind: 'core',
      input: {
        note: `The owner wrote in the technical channel (message ${message}), where ${asks.length} questions wait for him (${questions}), and it replies to none of them, so it was recorded on none. His reply to a question's own line there answers that question; where he means yours, tell him so in the technical channel with support.technical { need: "ask" }.`,
      },
      externalId: `owner-answer-several:${message}:${ask.id}`,
    });
    await deliverWaiting(room.id).catch((err) =>
      logger.error({ err, roomId: room.id }, 'support: a note waits for the next turn'),
    );
  }
}

/**
 * The owner's message answers one ask: it reaches the asker's thread as his message, marked the
 * answer to that question, and is written on the issue and the Forge question the ask named. A
 * message already taken there (a redelivered frame) answers nothing again.
 */
async function answerAsk(
  room: RoomRow,
  ask: ActionRow,
  message: { id: string; text: string },
  author: { key: string; label: string | null },
): Promise<void> {
  const asked = ask.input as AskInput;
  const thread = ask.thread;
  const taken = await db.transaction(async (tx) => {
    const row = await insertAction(
      {
        roomId: room.id,
        projectId: room.projectId,
        conversationId: ask.conversationId,
        thread,
        kind: 'message_in',
        actorKind: 'member',
        actorKey: author.key,
        actorLabel: author.label,
        input: { text: message.text, technicalChannel: (ask.output as AskedAt).rid },
        externalId: message.id,
      },
      tx,
    );
    if (!row) return false;
    if (ask.conversationId) {
      await appendMessagesIn(tx, {
        conversationId: ask.conversationId,
        messages: [
          {
            role: 'user',
            content: message.text,
            authorUserId: null,
            authorLabel: author.label ?? author.key,
            authorKey: author.key,
            externalId: message.id,
            replyToExternalId: null,
          },
        ],
      });
    }
    await insertAction(
      {
        roomId: room.id,
        projectId: room.projectId,
        conversationId: ask.conversationId,
        thread,
        kind: 'routed',
        actorKind: 'core',
        tool: ANSWER,
        input: { ask: ask.id, message: message.id, question: asked.question, record: asked.record },
        externalId: `owner-answer:${ask.id}`,
      },
      tx,
    );
    return true;
  });
  if (!taken) return;
  if (asked.questionId) {
    await answerForgeQuestion(room, thread, ask, asked.questionId, message, author.key);
  }
  if (!asked.issueId) return;
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
    const [q] = await db
      .select({
        status: agentQuestions.status,
        steps: agentQuestions.steps,
        projectId: agentQuestions.projectId,
      })
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
    // resolved where the answer is recorded; where he is no Forge account yet, it is kept (ISS-976)
    const questionProject = q.projectId ?? room.projectId;
    const { namespace } = await roomAuth(room);
    const owner = await resolveSpeaker(
      { source: 'rocketchat', namespace, externalId: ownerKey },
      questionProject,
    );
    if (!owner.linked) {
      await keepOwnerAnswer(room, thread, {
        questionId,
        questionProjectId: questionProject,
        round: step.round,
        message: message.id,
        ownerKey,
        answer,
      });
      return ownerSetupStep(questionProject);
    }
    const gap = await ownerRoleGap(owner.userId, questionProject);
    if (gap) return gap;
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
