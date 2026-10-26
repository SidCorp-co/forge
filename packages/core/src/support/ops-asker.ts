// Whom an operations room's act runs for (REQ-75 BC-21). Core names the asker, never the session:
// the member who wrote last in the thread, by the account id Rocket.Chat signed the message with.
// That account is a Forge user when a confirmed speaker link names it (the explicit map, which wins),
// or when the address the chat server holds for it, verified there, is a Forge account's verified
// address. Anyone else is unmapped and may only read; the act is refused naming why.

import { resolveSpeaker } from '../assistant/index.js';
import { verifiedUserIdByEmail } from '../auth/index.js';
import { fetchUserProfile } from '../integrations/rocketchat/index.js';
import { no, type Outcome } from './outcome.js';
import { latestThreadWriter, type RoomRow } from './store.js';
import { roomAuth } from './thread.js';

export interface Asker {
  key: string;
  label: string | null;
  userId: string;
  /** How the account was named a Forge user: a confirmed link, or the chat server's verified address. */
  via: 'link' | 'email';
}

const unmapped = (who: string, why: string): Outcome<Asker> =>
  no(
    'OPS_ASKER_UNMAPPED',
    '/thread',
    `${who} is not a Forge user this room can name (${why}), so they can only read here. Confirm a speaker link for the account, or give it on the chat server the address their Forge account uses, verified on both.`,
  );

/** The Forge user the thread's latest writer is, or the refusal saying they are nobody Forge knows. */
export async function askerOf(room: RoomRow, thread: string): Promise<Outcome<Asker>> {
  const writer = await latestThreadWriter(room.id, thread);
  if (!writer) {
    return no('SUPPORT_THREAD_UNKNOWN', '/thread', `no member has written in thread ${thread}`);
  }
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
  if (!profile) return unmapped(who, 'the chat server would not say who the account is');
  if (!profile.email) return unmapped(who, 'the account has no address on the chat server');
  if (!profile.emailVerified) {
    return unmapped(who, `the chat server has not verified ${profile.email}`);
  }
  const userId = await verifiedUserIdByEmail(profile.email);
  if (!userId) return unmapped(who, `no Forge account holds ${profile.email}, verified`);
  return { ok: true, value: { ...writer, userId, via: 'email' } };
}
