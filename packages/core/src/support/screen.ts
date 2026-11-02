// The screen every line the session writes passes before it is posted (REQ-75): `support-reply` for
// readers who hold no role, where developer detail is refused, and `operations-reply` for the team
// a room was bound for. No room takes an internal code (ISS-872, ISS-873): an issue key, an MR or PR
// number, an environment variable's name, a commit sha or a credential word is refused by name,
// save in a reply inside a member's own thread of a room the team reads, where they asked for the
// detail. A refused line is recorded and nothing is posted.

import type { ProvenMessage } from '@forge/contracts/messaging';
import { screened } from '../conversations/index.js';
import { refusalsOf } from '../messaging/contract.js';
import { internalCodesIn, PLAIN_WORDS_SHAPE } from '../messaging/internal-codes.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import { readersOf } from './grants.js';
import { no, type Outcome } from './outcome.js';
import { isCoreThread } from './rules.js';
import { insertAction, type RoomRow, threadMembers } from './store.js';
import { TOP_LEVEL } from './thread.js';

export type SessionDoor = 'support-reply' | 'operations-reply';

/** The acts that answer a member in their own thread; every other act (a question, an announcement, a finding) is plain words. */
const MEMBER_REPLY_TOOLS: ReadonlySet<string> = new Set(['reply', 'route', 'master_post']);

/**
 * Why this post may carry no internal code, or null where it may (ISS-873): only a reply inside a
 * thread a member wrote in, in a room the team reads, where that member asked for the detail.
 */
export async function codesBarredBecause(
  room: RoomRow,
  thread: string,
  tool: string,
): Promise<string | null> {
  if ((await readersOf(room)) === 'users') return `${room.rid} is read by the product's users`;
  if (thread === TOP_LEVEL)
    return `a post at the top level of ${room.rid} is read by everyone there`;
  if (isCoreThread(thread)) return `a post for ${thread} is no member's thread`;
  if (!MEMBER_REPLY_TOOLS.has(tool)) {
    return `${tool} asks or tells someone something unprompted, and that is said in plain words in every room`;
  }
  if ((await threadMembers(room.id, thread)).length === 0) {
    return `no member wrote in thread ${thread} of ${room.rid}, so nobody asked for the detail`;
  }
  return null;
}

export async function screenForThread(
  room: RoomRow,
  conversationId: string | null,
  thread: string,
  text: string,
  door: SessionDoor,
  tool: string,
): Promise<Outcome<{ text: string; proof: ProvenMessage }>> {
  const found = internalCodesIn(text);
  const barred = found.length > 0 ? await codesBarredBecause(room, thread, tool) : null;
  const codes = barred ? found : [];
  if (codes.length > 0) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread,
      kind: 'refused',
      actorKind: 'session',
      tool,
      input: { text, door },
      output: { code: 'SUPPORT_INTERNAL_CODE', codes },
    });
    return no(
      'SUPPORT_INTERNAL_CODE',
      '/text',
      `nothing was posted: ${barred}, and the post holds ${codes.map((c) => `${c.kind} "${c.quote}"`).join(', ')}. ${PLAIN_WORDS_SHAPE}. Codes are shown only in a reply inside the thread of a team member who asked for the detail.`,
    );
  }
  const verdict = await screenReplyAtDoor(door, {
    projectId: room.projectId,
    segments: [text],
    toolCalls: [],
    progress: null,
  });
  const admitted = screened(text, door, verdict);
  if (admitted?.proof) return { ok: true, value: { text, proof: admitted.proof } };
  const why = refusalsOf(verdict).map(
    (r) => `${r.rule}: ${r.why}${r.quote ? ` ("${r.quote}")` : ''} — ${r.shape}`,
  );
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread,
    kind: 'refused',
    actorKind: 'session',
    tool,
    input: { text, door },
    output: { screen: why },
  });
  return no(
    'SUPPORT_REPLY_REFUSED',
    '/text',
    `nothing was posted: ${why.join('; ') || 'the screen refused the reply'}. Rewrite it and reply again.`,
  );
}
