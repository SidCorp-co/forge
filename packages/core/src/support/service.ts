// What a support group's session does in a thread (REQ-75): read it (BC-16), list and run its
// granted diagnose tools (BC-12), and reply (BC-11), every reply scrubbed and screened before it is
// posted. Searching is `search.ts`, proposing a fix `fixes.ts`, recording Feedback `record.ts`.

import type { SupportTool } from '@forge/contracts/support';
import { readMessages, screened } from '../conversations/index.js';
import { findBindingWithConnectionById } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import {
  activeSupportApi,
  callGranted,
  planCall,
  type SupportCallArgs,
  type SupportCallResult,
} from '../integrations/support-api/index.js';
import { refusalsOf } from '../messaging/contract.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import type { Refusal } from './refusals.js';
import { checkLine, limitsOf } from './rules.js';
import { insertAction, type RoomRow } from './store.js';
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
  return ((pair?.binding.config ?? null) as RocketChatBindingConfig | null)?.support ?? null;
}

/**
 * Post the session's reply in a thread: scrubbed, then screened as a reply to people who hold no role
 * in a support group, and to the team an operations room was bound for.
 */
export async function reply(
  room: RoomRow,
  input: { thread: string; text: string },
): Promise<Outcome<{ messageId: string | null }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const text = await scrubbedForRoom(room, input.text);
  // a team reads an operations room and a support group bound with `readers: team` (REQ-75 r5)
  const team = room.kind === 'operations' || (await roomConfig(room))?.readers === 'team';
  const door = team ? 'operations-reply' : 'support-reply';
  const verdict = await screenReplyAtDoor(door, {
    projectId: room.projectId,
    segments: [text],
    toolCalls: [],
    progress: null,
  });
  const admitted = screened(text, door, verdict);
  if (!admitted?.proof) {
    const why = refusalsOf(verdict).map(
      (r) => `${r.rule}: ${r.why}${r.quote ? ` ("${r.quote}")` : ''} — ${r.shape}`,
    );
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'refused',
      actorKind: 'session',
      tool: 'reply',
      input: { text },
      output: { screen: why },
    });
    return no(
      'SUPPORT_REPLY_REFUSED',
      '/text',
      `nothing was posted: ${why.join('; ') || 'the screen refused the reply'}. Rewrite it and reply again.`,
    );
  }
  const posted = await postInThread({ room, thread: input.thread, text, proof: admitted.proof });
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
