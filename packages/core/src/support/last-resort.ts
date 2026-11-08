// A support room's last-resort line (ISS-875): core speaks in a member's thread on its own only where
// its agent cannot (no box runs it, its turn failed, the member is past the hourly limit), in the
// plain Vietnamese line `conversations/last-resort.ts` holds, once per wait whichever case it is: the
// session answering in the thread ends the wait (`endLastResortWait`), so a thread that fails again
// later is told again (ISS-977). A failed turn's line is told only once core's own retries ran out,
// and says the message stays queued (`turn-retry.ts:retryOrTell`). A thread no member wrote in (a scheduled check, a release note, a parked question, the top level)
// is never told: the line goes only inside the person's own thread.
//
// A broken session is the one case told to the room rather than a thread (ISS-1105): one line at
// the room's top level, once per wait, claimed under the room's top-level venue and given back when
// a turn of the session completes (`endRoomLastResortWait`).

import {
  claimLastResort,
  confidentLanguageOf,
  type LastResortKind,
  type LastResortPlace,
  ROOM_STILL_QUEUED_LINES,
  releaseLastResort,
  STILL_QUEUED_LINE,
} from '../conversations/index.js';
import { FIXED_REPLY_CONSTANT, sendFixedReply } from '../integrations/rocketchat/index.js';
import { logger } from '../lib/logger.js';
import { readContentLanguage } from '../project-config/index.js';
import { isCoreThread, supportVenueId } from './rules.js';
import type { RoomRow } from './store.js';
import { postForTopLevel, postInThread, roomAuth, TOP_LEVEL } from './thread.js';

/** What telling a thread came to: the message posted, or why nothing was. */
export type Told =
  | { posted: true; messageId: string | null; conversationId: string }
  | { posted: false; why: 'not-a-member-thread' | 'already-told' | 'post-failed' };

/**
 * Tell `thread` the one line of `kind`, unless it is no member's thread or was told one already.
 * `unrecorded` posts it without writing it on the thread's conversation, for a thread whose
 * conversation is what failed to open (ISS-1046); its `conversationId` is then empty.
 */
export async function tellLastResort(
  room: RoomRow,
  thread: string,
  kind: LastResortKind,
  opts: { unrecorded?: boolean } = {},
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
    if (opts.unrecorded) {
      const { auth } = await roomAuth(room);
      const sent = await sendFixedReply(
        { kind: 'rest', auth, rid: room.rid, tmid: thread },
        line,
        FIXED_REPLY_CONSTANT,
      );
      return { posted: true, messageId: sent.messageId, conversationId: '' };
    }
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

/**
 * Tell the room's people once that its session cannot answer (ISS-1105): one line at its top level,
 * in the room's content language (`roomLanguage`), unless the room was told already while it waits.
 * `texts` are the waiting messages the line is told for.
 */
export async function tellRoomLastResort(room: RoomRow, texts: readonly string[]): Promise<Told> {
  const place = await placeOf(room, TOP_LEVEL);
  const line = await claimLastResort(
    place,
    'turn_failed',
    ROOM_STILL_QUEUED_LINES[await roomLanguage(room, texts)],
  );
  if (!line) return { posted: false, why: 'already-told' };
  try {
    const posted = await postForTopLevel({ room, text: line, proof: FIXED_REPLY_CONSTANT });
    if (posted.ok) {
      return {
        posted: true,
        messageId: posted.value.messageId,
        conversationId: posted.value.conversationId,
      };
    }
    logger.error(
      { roomId: room.id, refusals: posted.refusals },
      "support: the room's last-resort line has no place to go",
    );
  } catch (err) {
    logger.error(
      { err, roomId: room.id },
      "support: the room's last-resort line could not be posted",
    );
  }
  await releaseLastResort(place);
  return { posted: false, why: 'post-failed' };
}

/**
 * The room's language for its one line: the project's content language where its document declares
 * one, else Vietnamese where a waiting message reads Vietnamese, else English. The project decides
 * first; the messages decide only for a project that never said.
 */
async function roomLanguage(room: RoomRow, texts: readonly string[]): Promise<'vi' | 'en'> {
  const setting = await readContentLanguage(room.projectId);
  if (setting.source === 'document') {
    return setting.contentLanguage.toLowerCase().startsWith('vi') ? 'vi' : 'en';
  }
  return texts.some((t) => confidentLanguageOf(t) === 'vi') ? 'vi' : 'en';
}

/** A turn of the room's session completed: the room's wait is over, and a later break is told again. */
export async function endRoomLastResortWait(room: RoomRow): Promise<void> {
  await releaseLastResort(await placeOf(room, TOP_LEVEL));
}
