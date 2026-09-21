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
export type DirectRoomResult = { ok: true; rid: string } | { ok: false; reason: string };

const IM_CREATE_TIMEOUT_MS = 10_000;

/**
 * Open (or find) the direct room between this bot and one account.
 */
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
