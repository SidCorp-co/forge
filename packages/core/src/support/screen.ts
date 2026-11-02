// The screen every line the session writes passes before it is posted (REQ-75): `support-reply` for
// readers who hold no role, where developer detail is refused, and `operations-reply` for the team
// a room was bound for. A room the product's users read takes no internal code whatever the door
// (ISS-872): an issue key, an MR or PR number, an environment variable's name, a commit sha or a
// credential word is refused by name. A refused line is recorded and nothing is posted.

import type { ProvenMessage } from '@forge/contracts/messaging';
import { screened } from '../conversations/index.js';
import { refusalsOf } from '../messaging/contract.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import { readersOf } from './grants.js';
import { no, type Outcome } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

export type SessionDoor = 'support-reply' | 'operations-reply';

/** One kind of internal code, as the refusal names it, and how it is found. */
const INTERNAL_CODES: readonly { kind: string; re: RegExp }[] = [
  // a tracker's key: a project prefix, a dash and a number (ISS-89, FB-12, REQ-77)
  { kind: 'issue key', re: /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g },
  // GitLab's merge request reference (!5050), or a number said to be an MR or a PR
  { kind: 'MR or PR number', re: /(?<![\w!])!\d{1,7}\b/g },
  {
    kind: 'MR or PR number',
    re: /\b(?:PR|MR|pull\s+request|merge\s+request)\s*[#!]?\d{1,7}\b/gi,
  },
  // upper snake case with at least one underscore, a wildcard segment included (VIRTUAL_MACHINES_*_KEY)
  {
    kind: 'environment variable name',
    re: /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_(?:[A-Z0-9]+|\*))+(?![A-Za-z0-9_])/g,
  },
  // 7 to 40 lower-case hex holding a letter and a digit: an order number is digits alone
  {
    kind: 'commit sha',
    re: /(?<![A-Za-z0-9])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![A-Za-z0-9])/g,
  },
  {
    kind: 'credential word',
    re: /\b(?:tokens?|secrets?|passwords?|credentials?|key\s+rotation)\b/gi,
  },
];

/** The internal codes a text holds, each with the words that hold it, in the order of the kinds. */
export function internalCodesIn(text: string): { kind: string; quote: string }[] {
  const found: { kind: string; quote: string }[] = [];
  for (const { kind, re } of INTERNAL_CODES) {
    for (const m of text.matchAll(re)) {
      if (!found.some((f) => f.quote === m[0])) found.push({ kind, quote: m[0] });
    }
  }
  return found;
}

/** The shape a post to a users' room passes, said the same way by every refusal. */
export const PLAIN_WORDS_SHAPE =
  'Say it in plain words, with no issue key, MR or PR number, environment variable name, commit sha or credential word; an order number or a PO code such as PO001453760102901 may stay';

export async function screenForThread(
  room: RoomRow,
  conversationId: string | null,
  thread: string,
  text: string,
  door: SessionDoor,
  tool: string,
): Promise<Outcome<{ text: string; proof: ProvenMessage }>> {
  const codes = (await readersOf(room)) === 'users' ? internalCodesIn(text) : [];
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
      `nothing was posted: ${room.rid} is read by the product's users, and the post holds ${codes.map((c) => `${c.kind} "${c.quote}"`).join(', ')}. ${PLAIN_WORDS_SHAPE}.`,
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
