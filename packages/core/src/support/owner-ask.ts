// A channel agent's question to the owner, through the channel (REQ-77 BC-12). The agent asks in a
// thread; the owner's next message in that thread, by the id the chat server signed, is the answer.
// It reaches the asking session as its next message (marked as the answer to that question), and the
// issue the question named, where one was named, as a note carrying the owner's own words. Nobody
// else's message answers it, whatever it says: who wrote it is the server's word, never the text's.
// Both halves are `routed` actions of the thread, so no state lives anywhere the record does not.

import { and, asc, eq, inArray } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { granters, grantsOf, supportConfigOf } from './grants.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { threadLink } from './record.js';
import { screenForThread } from './screen.js';
import { type ActionRow, insertAction, type RoomRow } from './store.js';
import { postInThread, scrubbedForRoom } from './thread.js';

const ASK = 'ask_owner';
const ANSWER = 'owner_answer';

interface AskInput {
  question: string;
  /** The issue key the answer is also written on. */
  record: string | null;
  issueId: string | null;
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
 * Ask the owner the binding names, in a thread of the agent's group. Refused by name, nothing posted,
 * when the room is not a channel agent's, the binding names no owner, the thread is unknown, or the
 * issue the answer should be written on is not one of this project.
 */
export async function askOwner(
  room: RoomRow,
  input: { thread: string; question: string; record?: string | undefined },
): Promise<Outcome<{ messageId: string | null; mentioned: boolean; record: string | null }>> {
  if (room.kind !== 'agent') {
    return no(
      'SUPPORT_OWNER_NOT_NAMED',
      '/action',
      "ask_owner is a channel agent's act: this room's binding carries no `agent` block, so it names no owner to ask",
    );
  }
  const owner = grantsOf(await supportConfigOf(room)).owner;
  if (!owner) {
    return no(
      'SUPPORT_OWNER_NOT_NAMED',
      '/action',
      `this agent's binding names no owner, so nobody was asked: name the owner's Rocket.Chat user id in its grant; ${await granters(room.projectId)}`,
    );
  }
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const issue = input.record ? await issueOfKey(room.projectId, input.record) : null;
  if (input.record && !issue) {
    return no(
      'SUPPORT_OWNER_RECORD_UNKNOWN',
      '/record',
      `${input.record} names no issue of this project, so the answer would be written nowhere; nothing was asked`,
    );
  }
  const username = await ownerUsername(room.projectId, owner);
  const text = await scrubbedForRoom(
    room,
    `${username ? `@${username} ` : 'Owner: '}${input.question}\n\nAnswer in this thread: your next message here is the answer.`,
  );
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
    value: { messageId: posted.messageId, mentioned: username !== null, record: asked.record },
  };
}

/** The questions a thread asked the owner that no message has answered yet, oldest first. */
async function openAsks(room: RoomRow, thread: string): Promise<ActionRow[]> {
  const rows = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.thread, thread),
        eq(supportActions.kind, 'routed'),
        inArray(supportActions.tool, [ASK, ANSWER]),
      ),
    )
    .orderBy(asc(supportActions.createdAt));
  const answered = new Set(
    rows.filter((r) => r.tool === ANSWER).map((r) => (r.input as { ask?: string }).ask),
  );
  return rows.filter((r) => r.tool === ASK && !answered.has(r.id));
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
  for (const ask of await openAsks(room, thread)) {
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
