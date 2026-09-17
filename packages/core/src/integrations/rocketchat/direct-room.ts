// The direct room a person is reachable at, for a round that may not be asked
// in public.
//
// Its own module rather than a branch inside the destination resolver, because
// what it does is a conversation with Rocket.Chat — a directory read and a room
// open — and every step of it can answer "no" for a reason the operator needs
// told (ISS-1091 outcome 2).

import { logger } from '../../logger.js';
import { fetchUserProfile, type RocketChatRestAuth } from './rest-client.js';

/**
 * The direct room, or why there is none, in the words the operator is shown.
 */
// cm:guard tagged on `ok` rather than on a nullable `rid`, because the caller's fallback for a round
// it cannot direct-message is the ROOM THE WINDOW IS IN — the disclosure this path exists to prevent
// — and a union the compiler cannot narrow is one a caller reads with a truthiness test that an
// empty string passes (ISS-1091 criterion 5).
export type DirectRoomResult = { ok: true; rid: string } | { ok: false; reason: string };

const IM_CREATE_TIMEOUT_MS = 10_000;

/**
 * Open (or find) the direct room between this bot and one account.
 */
// cm:guard `im.create` is IDEMPOTENT on Rocket.Chat — it answers the existing room where one is
// already open — so this is a lookup that happens to create, and calling it on every sensitive round
// costs one request rather than a duplicate room.
// cm:guard it takes a USERNAME and not the account id, which is why the directory read above it is
// not optional: `im.create` has no `userId` form, and an id sent as a username opens a room with
// nobody or fails, either of which would put a private round somewhere the asker is not.
async function openDirectRoom(
  auth: RocketChatRestAuth,
  username: string,
): Promise<DirectRoomResult> {
  const base = auth.serverUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IM_CREATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/v1/im.create`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': auth.authToken,
        'X-User-Id': auth.userId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
      room?: { _id?: unknown };
    } | null;
    if (!res.ok || body?.success === false) {
      return {
        ok: false,
        reason: `Rocket.Chat refused to open a direct room with @${username}: ${body?.error ?? `status ${res.status}`}`,
      };
    }
    const rid = body?.room?._id;
    if (typeof rid !== 'string' || !rid) {
      return { ok: false, reason: `Rocket.Chat opened no direct room with @${username}` };
    }
    return { ok: true, rid };
  } catch (err) {
    logger.error({ err, username }, 'rocketchat.direct-room: im.create failed');
    return {
      ok: false,
      reason: `the direct room with @${username} could not be opened: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The direct room this speaker is reachable at, or the reason there is none.
 */
// cm:guard the speaker is addressed by the TRANSPORT's own id for them, taken from the message they
// sent, and never by the display label beside it: a Rocket.Chat display name is re-assignable, so a
// private round addressed by name can reach whoever holds that name today (the same rule
// `escalation.ts`'s `cm:edge` states for its own stored principal).
// cm:guard every "no" here is a REASON and never a null the caller can shrug at, because the caller's
// only other option for a sensitive round is the room the window is in — which is the disclosure this
// whole path exists to prevent (ISS-1091 criterion 5).
export async function directRoomFor(
  auth: RocketChatRestAuth,
  speakerExternalId: string | null,
): Promise<DirectRoomResult> {
  if (!speakerExternalId) {
    return {
      ok: false,
      reason:
        'this round is private to whoever asked, and the message it came from names no Rocket.Chat account to send it to',
    };
  }
  const profile = await fetchUserProfile(auth, speakerExternalId);
  if (!profile?.username) {
    return {
      ok: false,
      reason: `this round is private to whoever asked, and this bot cannot read account ${speakerExternalId} from the server's directory to find their handle`,
    };
  }
  return openDirectRoom(auth, profile.username);
}
