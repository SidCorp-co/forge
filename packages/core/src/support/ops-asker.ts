// Whom an operations room's act runs for (REQ-75 BC-21). Core names the asker, never the session:
// the member who wrote the message the act names, one handed to the room's current turn in that
// thread, by the account id Rocket.Chat signed the message with. The thread's latest writer was
// read here before (ISS-716): a member writing in the thread while the turn worked, or a thread
// named from another, made the act run as someone who never asked for it.
// That account is a Forge user when a confirmed speaker link names it (the explicit map, which wins),
// or when the address the chat server holds for it, verified there, is a Forge account's verified
// address. Anyone else is unmapped and may only read; the act is refused naming why.

import { resolveSpeaker } from '../assistant/index.js';
import { verifiedUserIdByEmail } from '../auth/index.js';
import { fetchUserProfile } from '../integrations/rocketchat/index.js';
import { logger } from '../lib/logger.js';
import { writerOfHandedMessage } from './delivery.js';
import { DIRECT_THREAD, directAskerOf } from './direct-asker.js';
import { no, type Outcome } from './outcome.js';
import { type RoomRow, roomById } from './store.js';
import { roomAuth } from './thread.js';

export interface Asker {
  key: string;
  label: string | null;
  userId: string;
  /**
   * How the account was named a Forge user: a confirmed link, the chat server's verified address, or
   * the sender of the direct message the turn was handed (ISS-950).
   */
  via: 'link' | 'email' | 'direct';
}

const unmapped = (who: string, why: string, needs?: string): Outcome<Asker> =>
  no(
    'OPS_ASKER_UNMAPPED',
    '/thread',
    `${who} is not a Forge user this room can name (${why}), so they can only read here${needs ? `: this act takes ${needs}, held by a Forge user` : ''}. Confirm a speaker link for the account, or give it on the chat server the address their Forge account uses, verified on both.`,
  );

/**
 * The Forge user who wrote `message`, the member's message asking for the act, or the refusal
 * saying why the act has no asker: no such message handed to this turn in `thread`, or a writer
 * Forge cannot name. `needs` is the permission the act takes, which an unmapped refusal names.
 */
export async function askerOf(
  room: RoomRow,
  thread: string,
  message: string,
  needs: string,
): Promise<Outcome<Asker>> {
  if (thread === DIRECT_THREAD) return directAskerOf(room, message);
  const writer = await writerOfHandedMessage(room.id, thread, message);
  if (!writer) {
    return no(
      'OPS_ASKER_MESSAGE_UNKNOWN',
      '/message',
      `message ${message} is no member's message in thread ${thread} that this turn was handed; an act runs as the member whose message asked for it, so name that message, as it carries \`message\` in what you were handed`,
    );
  }
  return forgeUserOfWriter(room, writer, needs);
}

/** The Forge user one of the room's writers is, or the refusal saying they are nobody Forge knows. */
export async function forgeUserOfWriter(
  room: RoomRow,
  writer: { key: string; label: string | null },
  needs?: string,
): Promise<Outcome<Asker>> {
  const who = writer.label ? `@${writer.label}` : `account ${writer.key}`;
  const { auth, namespace } = await roomAuth(room);
  const linked = await resolveSpeaker({
    source: 'rocketchat',
    namespace,
    externalId: writer.key,
    label: writer.label,
  });
  if (linked.linked) return { ok: true, value: { ...writer, userId: linked.userId, via: 'link' } };
  const profile = await fetchUserProfile(auth, writer.key).catch(() => null);
  if (!profile) return unmapped(who, 'the chat server would not say who the account is', needs);
  if (!profile.email) return unmapped(who, 'the account has no address on the chat server', needs);
  if (!profile.emailVerified) {
    return unmapped(who, `the chat server has not verified ${profile.email}`, needs);
  }
  const userId = await verifiedUserIdByEmail(profile.email);
  if (!userId) return unmapped(who, `no Forge account holds ${profile.email}, verified`, needs);
  return { ok: true, value: { ...writer, userId, via: 'email' } };
}

/**
 * The Forge user a room's writer is, for a correction they said (REQ-50 BC-1): null where they are
 * nobody Forge knows, or the room is gone; a correction is kept either way.
 */
export async function roomWriterUserId(
  roomId: string,
  writer: { key: string; label: string | null },
): Promise<string | null> {
  const room = await roomById(roomId);
  if (!room) return null;
  // a room whose bot credential is gone names nobody; the correction is still kept
  const named = await forgeUserOfWriter(room, writer).catch((err: unknown) => {
    logger.warn({ err, roomId }, 'support: a room writer could not be named for a correction');
    return null;
  });
  return named?.ok ? named.value.userId : null;
}
