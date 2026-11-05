// A support room's last-resort line (ISS-875): core speaks in a member's thread on its own only where
// its agent cannot (no box runs it, its turn failed, the member is past the hourly limit), in the
// plain Vietnamese line `conversations/last-resort.ts` holds, once per wait whichever case it is: the
// session answering in the thread ends the wait (`endLastResortWait`), so a thread that fails again
// later is told again (ISS-977). A failed turn's line is told only once core's own retries ran out,
// and says the message stays queued (`dispatch.ts:retryOrTell`). A thread no member wrote in (a scheduled check, a release note, a parked question, the top level)
// is never told: the line goes only inside the person's own thread.

import {
  claimLastResort,
  type LastResortKind,
  type LastResortPlace,
  releaseLastResort,
  STILL_QUEUED_LINE,
} from '../conversations/index.js';
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
  const place = await placeOf(room, thread);
  // a support thread's failed message is still held and handed on, so it is never asked to resend
  const line = await claimLastResort(
    place,
    kind,
    kind === 'turn_failed' ? STILL_QUEUED_LINE : undefined,
  );
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

/** The thread as its chat server knows it, where its one last-resort line is claimed. */
async function placeOf(room: RoomRow, thread: string): Promise<LastResortPlace> {
  const { namespace } = await roomAuth(room);
  return { adapter: 'rocketchat', venue: supportVenueId(namespace, room.rid, thread) };
}

/**
 * The session answered in `thread`: the wait a last-resort line told it of is over, so a later
 * case tells it again rather than leaving it silent (ISS-977).
 */
export async function endLastResortWait(room: RoomRow, thread: string): Promise<void> {
  if (thread === TOP_LEVEL || isCoreThread(thread)) return;
  await releaseLastResort(await placeOf(room, thread));
}
