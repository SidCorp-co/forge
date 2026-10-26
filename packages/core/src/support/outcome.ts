// The answer each support act gives: its value, or the refusals naming what could not stand.

import { type Refusal, refusalOf } from './refusals.js';
import { type RoomRow, threadConversation } from './store.js';

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusals: Refusal[] };

export const no = <T>(code: Refusal['code'], path: string, detail: string): Outcome<T> => ({
  ok: false,
  refusals: [refusalOf(code, path, detail)],
});

/** A thread the session may act in: one a member wrote in, in its own room. */
export async function knownThread(room: RoomRow, thread: string): Promise<string | null> {
  return threadConversation(room.id, thread);
}

export const threadUnknown = <T>(thread: string): Outcome<T> =>
  no(
    'SUPPORT_THREAD_UNKNOWN',
    '/thread',
    `no member has written in thread ${thread} of this group`,
  );
