// What a support group's session does in a thread (REQ-75): read it (BC-16), list and run its
// granted diagnose tools (BC-12), and reply (BC-11), every reply scrubbed and screened before it is
// posted. Searching is `search.ts`, proposing a fix `fixes.ts`, recording Feedback `record.ts`.

import type { SupportTool } from '@forge/contracts/support';
import { readMessages } from '../conversations/index.js';
import { findBindingWithConnectionById } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import {
  activeSupportApi,
  callGranted,
  planCall,
  type SupportCallArgs,
  type SupportCallResult,
} from '../integrations/support-api/index.js';
import { askerOf, mentionRefusal, readerOf } from './channel.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import type { Refusal } from './refusals.js';
import { checkLine, limitsOf } from './rules.js';
import { type SessionDoor, screenForThread } from './screen.js';
import { insertAction, type RoomRow, unansweredInThread } from './store.js';
import { noteInThread, postInThread, scrubbedForRoom } from './thread.js';

export type { Outcome } from './outcome.js';

/** A thread's recorded lines, oldest first. */
export async function readThread(
  room: RoomRow,
  thread: string,
): Promise<Outcome<{ role: string; from: string | null; text: string; at: string }[]>> {
  const conversationId = await knownThread(room, thread);
  if (!conversationId) return threadUnknown(thread);
  const lines = await readMessages(conversationId, 60);
  return {
    ok: true,
    value: lines.map((m) => ({
      role: m.role,
      from: m.role === 'user' ? (m.authorLabel ?? m.authorKey ?? null) : null,
      text: m.content,
      at: m.createdAt.toISOString(),
    })),
  };
}

/** What the session may call: each granted tool's name, kind, summary and arguments; never the credential. */
export async function listTools(room: RoomRow): Promise<Outcome<Omit<SupportTool, 'path'>[]>> {
  const api = await activeSupportApi(room.projectId);
  return {
    ok: true,
    value: (api?.tools ?? []).map(({ path: _path, ...t }) => t),
  };
}

/** Run a granted diagnose tool; the thread is shown what was checked (BC-12). */
export async function runDiagnose(
  room: RoomRow,
  input: { thread: string; tool: string; args: SupportCallArgs },
): Promise<Outcome<SupportCallResult>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const api = await activeSupportApi(room.projectId);
  if (!api)
    return no(
      'SUPPORT_TOOLS_UNBOUND',
      '/tool',
      'this project grants its support session no tools: bind a support-api integration first',
    );
  const planned = planCall({
    config: api.config,
    tools: api.tools,
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
  const called = await callGranted({
    plan: planned.plan,
    config: api.config,
    headers: api.headers,
    maxBytes: limitsOf(config).responseMaxBytes,
  });
  if ('refusal' in called) return refusedWith(called.refusal.code, called.refusal.detail);
  const { result } = called;
  const posted = await postInThread({
    room,
    thread: input.thread,
    text: checkLine(planned.plan.tool.summary, result.status, result.durationMs),
  });
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
    externalId: posted.messageId,
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
  input: { thread: string; text: string },
): Promise<Outcome<{ messageId: string | null }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  // a channel agent posts results only, one per request (REQ-77 BC-8): a second post with nothing
  // new to answer is an acknowledgement or progress, and is refused by name
  if (room.kind === 'agent' && !(await unansweredInThread(room.id, input.thread))) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'refused',
      actorKind: 'session',
      tool: 'reply',
      input: { text: input.text },
      output: { code: 'SUPPORT_ONE_RESULT_PER_REQUEST' },
    });
    return no(
      'SUPPORT_ONE_RESULT_PER_REQUEST',
      '/thread',
      'your last post in this thread is its result, and no message has arrived there since: one result per request, never an acknowledgement or progress. Nothing was posted. Keep what you have until the next message in this thread, and answer all of it in that one post.',
    );
  }
  const text = await scrubbedForRoom(room, input.text);
  const asker = await askerOf(room, input.thread);
  const mentions = await mentionRefusal<{ messageId: string | null }>(room, text, asker.username);
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
    input: { text },
    externalId: posted.messageId,
  });
  return { ok: true, value: { messageId: posted.messageId } };
}

/** The door a reply to this asker passes (BC-37). */
async function doorOf(room: RoomRow, member: Parameters<typeof readerOf>[0]): Promise<SessionDoor> {
  if (room.kind !== 'operations') {
    const reader = readerOf(member);
    if (reader) return reader === 'detail' ? 'operations-reply' : 'support-reply';
  }
  const team = room.kind === 'operations' || (await roomConfig(room))?.readers === 'team';
  return team ? 'operations-reply' : 'support-reply';
}
