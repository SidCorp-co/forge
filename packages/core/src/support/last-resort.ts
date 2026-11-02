// A support room's last-resort line (ISS-875): core speaks in a member's thread on its own only where
// its agent cannot (no box runs it, its turn failed, the member is past the hourly limit), in the
// plain Vietnamese line `conversations/last-resort.ts` holds, once per thread whichever case it is.
// A thread no member wrote in (a scheduled check, a release note, a parked question, the top level)
// is never told: the line goes only inside the person's own thread.

import { claimLastResort, type LastResortKind, releaseLastResort } from '../conversations/index.js';
import { logger } from '../lib/logger.js';
import { isCoreThread, supportVenueId } from './rules.js';
import type { RoomRow } from './store.js';
import { postInThread, roomAuth, TOP_LEVEL } from './thread.js';

/** What telling a thread came to: the message posted, or why nothing was. */
export type Told =
  | { posted: true; messageId: string | null; conversationId: string }
  | { posted: false; why: 'not-a-member-thread' | 'already-told' | 'post-failed' };

/** Tell `thread` the one line of `kind`, unless it is no member's thread or was told one already. */
export async function tellLastResort(
  room: RoomRow,
  thread: string,
  kind: LastResortKind,
): Promise<Told> {
  if (thread === TOP_LEVEL || isCoreThread(thread)) {
    return { posted: false, why: 'not-a-member-thread' };
  }
  const { namespace } = await roomAuth(room);
  const place = { adapter: 'rocketchat', venue: supportVenueId(namespace, room.rid, thread) };
  const line = await claimLastResort(place, kind);
  if (!line) return { posted: false, why: 'already-told' };
  try {
    const posted = await postInThread({ room, thread, text: line });
    return { posted: true, messageId: posted.messageId, conversationId: posted.conversationId };
  } catch (err) {
    logger.error(
      { err, roomId: room.id, thread, kind },
      'support: a last-resort line could not be posted',
    );
    await releaseLastResort(place);
    return { posted: false, why: 'post-failed' };
  }
}
