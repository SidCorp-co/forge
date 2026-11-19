// What a support group's session does in a thread (REQ-75): read it (BC-16), list and run its
// granted diagnose tools (BC-12), and reply (BC-11), every reply scrubbed and screened before it is
// posted. Searching is `search.ts`, proposing a fix `fixes.ts`, recording Feedback `record.ts`.

import { readMessages } from '../conversations/index.js';
import { findBindingWithConnectionById } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import {
  type BoundSupportTool,
  callGranted,
  planSupportCall,
  type SupportCallArgs,
  type SupportCallResult,
  supportApisOf,
} from '../integrations/support-api/index.js';
import { askerOf, mentionRefusal, readerOf } from './channel.js';
import { settleLatency } from './delivery.js';
import { readersOf } from './grants.js';
import { endLastResortWait } from './last-resort.js';
import { unreadLiveClaim } from './live-claims.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import type { Refusal } from './refusals.js';
import { limitsOf } from './rules.js';
import { type SessionDoor, screenForThread } from './screen.js';
import { insertAction, type RoomRow } from './store.js';
import { noteInThread, postInThread, scrubbedForRoom } from './thread.js';
import { ANSWERED_ELSEWHERE, type NamedRequest, resultOwed } from './thread-requests.js';

export type { Outcome } from './outcome.js';

/**
 * A thread's recorded lines, oldest first, each with the id the chat server gave it, so a message
 * the session was never handed (written before its restart) can still be cited (ISS-1106); null
 * on a line core wrote for itself.
 */
export async function readThread(
  room: RoomRow,
  thread: string,
): Promise<
  Outcome<{ id: string | null; role: string; from: string | null; text: string; at: string }[]>
> {
  const conversationId = await knownThread(room, thread);
  if (!conversationId) return threadUnknown(thread);
  const lines = await readMessages(conversationId, 60);
  return {
    ok: true,
    value: lines.map((m) => ({
      id: m.externalId,
      role: m.role,
      from: m.role === 'user' ? (m.authorLabel ?? m.authorKey ?? null) : null,
      text: m.content,
      at: m.createdAt.toISOString(),
    })),
  };
}

/**
 * What the session may call: each granted tool's name, kind, summary and arguments, and the binding
 * (the workspace) it reads; never the credential.
 */
export async function listTools(room: RoomRow): Promise<Outcome<Omit<BoundSupportTool, 'path'>[]>> {
  const { tools } = await supportApisOf(room.projectId);
  return { ok: true, value: tools.map(({ path: _path, ...t }) => t) };
}

/** Run a granted diagnose tool; the session is handed what came back, the thread nothing (BC-12). */
export async function runDiagnose(
  room: RoomRow,
  input: { thread: string; tool: string; args: SupportCallArgs },
): Promise<Outcome<SupportCallResult>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const apis = await supportApisOf(room.projectId);
  if (apis.bindings.length === 0)
    return no(
      'SUPPORT_TOOLS_UNBOUND',
      '/tool',
      'this project grants its support session no tools: bind a support-api integration first',
    );
  const planned = planSupportCall({
    apis,
    name: input.tool,
    kind: 'diagnose',
    args: input.args,
  });
  const refusedWith = async (code: Refusal['code'], detail: string) => {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'refused',
      actorKind: 'session',
      tool: input.tool,
      input: input.args,
      output: { code, detail },
    });
    await noteInThread(conversationId, `Refused ${input.tool}: ${detail}`);
    return no<SupportCallResult>(code, '/tool', detail);
  };
  if ('refusal' in planned) return refusedWith(planned.refusal.code, planned.refusal.detail);
  const config = await roomConfig(room);
  // the call goes out with the credential of the binding that grants the tool, and no other's
  const called = await callGranted({
    plan: planned.plan,
    config: planned.api.config,
    headers: planned.api.headers,
    maxBytes: limitsOf(config).responseMaxBytes,
  });
  if ('refusal' in called) return refusedWith(called.refusal.code, called.refusal.detail);
  const { result } = called;
  // REQ-75 r8 BC-12, BC-15: a check is recorded on its action and posts nothing in the room; the
  // session's answer is the thread's only message
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'diagnose',
    actorKind: 'session',
    tool: input.tool,
    input: input.args,
    output: result,
  });
  return { ok: true, value: result };
}

async function roomConfig(room: RoomRow) {
  const pair = await findBindingWithConnectionById(room.bindingId);
  const config = (pair?.binding.config ?? null) as RocketChatBindingConfig | null;
  // a channel agent's rooms are read under its `agent` block, the same shape (REQ-77)
  return (room.kind === 'agent' ? config?.agent : config?.support) ?? null;
}

/**
 * Post the session's reply in a thread: scrubbed, its mentions held to one person the channel lists
 * (REQ-75 r6 BC-34), then screened for whom it answers (BC-37): plain words for an asker holding only
 * User or Product roles, detail for a Technical or Maintenance one, and for an asker the channel does
 * not hold yet, the room's readers (a support group's users, unless bound `readers: team`; an
 * operations room's team).
 */
export async function reply(
  room: RoomRow,
  input: {
    thread: string;
    text: string;
    why?: string | undefined;
    turn?: string | null | undefined;
    request?: NamedRequest | undefined;
  },
): Promise<Outcome<{ messageId: string | null }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  // a channel agent posts results only, one per request (REQ-77 BC-8): a second post with nothing
  // new to answer is an acknowledgement or progress, and is refused by name; one naming the request
  // it answers is admitted in the thread that keeps the matter (ISS-1314)
  const owed =
    room.kind === 'agent' || input.request
      ? await resultOwed(room.id, input.thread, input.request)
      : null;
  if (owed && !owed.ok && (room.kind === 'agent' || owed.why === 'unknown')) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'refused',
      actorKind: 'session',
      tool: 'reply',
      input: { text: input.text, ...(input.request ? { request: input.request } : {}) },
      output: { code: 'SUPPORT_ONE_RESULT_PER_REQUEST' },
    });
    return no('SUPPORT_ONE_RESULT_PER_REQUEST', owed.pointer, noResultOwed(owed.why, input.request));
  }
  const elsewhere = owed?.ok ? owed.elsewhere : null;
  const text = await scrubbedForRoom(room, input.text);
  // what is live is said from a release read of this turn, never from memory (ISS-1123)
  const unread = await unreadLiveClaim<{ messageId: string | null }>(room, {
    thread: input.thread,
    conversationId,
    text,
    turn: input.turn,
    tool: 'reply',
  });
  if (unread) return unread;
  const asker = await askerOf(room, input.thread);
  const mentions = await mentionRefusal<{ messageId: string | null }>(
    room,
    text,
    asker.username,
    input.thread,
  );
  if (mentions) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'refused',
      actorKind: 'session',
      tool: 'reply',
      input: { text },
      output: { refusals: mentions.ok ? [] : mentions.refusals },
    });
    return mentions;
  }
  const admitted = await screenForThread(
    room,
    conversationId,
    input.thread,
    text,
    await doorOf(room, asker.member),
    'reply',
  );
  if (!admitted.ok) return admitted;
  const posted = await postInThread({
    room,
    thread: input.thread,
    text,
    proof: admitted.value.proof,
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: input.thread,
    kind: 'reply',
    actorKind: 'session',
    // why it answered, one line, kept for the daily review to tune the room's policy by (ISS-942)
    input: {
      text,
      ...(input.why ? { why: await scrubbedForRoom(room, input.why) } : {}),
      ...(elsewhere ? { request: elsewhere } : {}),
    },
    externalId: posted.messageId,
  });
  if (elsewhere) await answeredElsewhere(room, input.thread, elsewhere, posted.messageId);
  return { ok: true, value: { messageId: posted.messageId } };
}

/** Why a channel agent's post is no result owed, and what to do instead (REQ-77 BC-8, ISS-1314). */
function noResultOwed(why: 'answered' | 'unknown', request: NamedRequest | undefined): string {
  if (why === 'unknown') {
    return `no message ${request?.message} was asked in thread ${request?.thread} of this room, so this post answers no request. Nothing was posted. Name the request as you were handed it: its \`thread\` and its \`message\`.`;
  }
  if (request) {
    return `the request ${request.message} in thread ${request.thread} already has its result, posted there or in a thread that named it: one result per request. Nothing was posted. Keep what you have for the next message.`;
  }
  return 'your last post in this thread is its result, and no message has arrived there since: one result per request, never an acknowledgement or progress. Nothing was posted. Where this answers a request asked in another thread of this room and the matter is kept here, name it: support.reply { thread, text, request: { thread, message } }. Otherwise keep what you have until the next message in this thread, and answer all of it in that one post. Where the person here waits on work recorded or carried from another thread, promise them here with support.promise { thread, issue, environment }: Forge hands you a note in this thread once it is there, and that note opens your one post.';
}

/**
 * The request a reply in `thread` named, asked in another thread of the room, is answered (ISS-1314):
 * recorded in its own thread as that thread's result, posting nothing there, and the wait of every
 * message the session was handed there ends.
 */
async function answeredElsewhere(
  room: RoomRow,
  thread: string,
  request: NamedRequest,
  reply: string | null,
): Promise<void> {
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: await knownThread(room, request.thread),
    thread: request.thread,
    kind: 'routed',
    actorKind: 'session',
    tool: ANSWERED_ELSEWHERE,
    input: { message: request.message, thread, reply },
  });
  await settleLatency(room.id, request.thread, new Date());
  await endLastResortWait(room, request.thread);
}

/**
 * The session posts nothing for a message it was handed, and says why (ISS-942): recorded on the
 * room as `silent` with its reason, and as a system line on the thread's conversation, so a wrong
 * silence can be found and the room's policy tuned from real use. Code records it; it gates nothing.
 */
export async function staySilent(
  room: RoomRow,
  input: { thread: string; message?: string | undefined; reason: string },
): Promise<Outcome<{ silent: true }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const reason = await scrubbedForRoom(room, input.reason);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'silent',
    actorKind: 'session',
    input: { reason, ...(input.message ? { message: input.message } : {}) },
  });
  await noteInThread(conversationId, `stayed silent: ${reason}`);
  return { ok: true, value: { silent: true } };
}

/** The door a reply to this asker passes (BC-37). */
async function doorOf(room: RoomRow, member: Parameters<typeof readerOf>[0]): Promise<SessionDoor> {
  if (room.kind !== 'operations') {
    const reader = readerOf(member);
    if (reader) return reader === 'detail' ? 'operations-reply' : 'support-reply';
  }
  return (await readersOf(room)) === 'team' ? 'operations-reply' : 'support-reply';
}
