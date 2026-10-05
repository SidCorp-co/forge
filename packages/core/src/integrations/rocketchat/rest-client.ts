export interface RocketChatRestAuth {
  /** e.g. https://chat.sidcorp.co */
  serverUrl: string;
  authToken: string;
  userId: string;
}

import {
  mapMessage,
  mapMessages,
  type RawRestMessage,
  type RocketChatRestMessage,
} from './rest-message.js';

export {
  extractMessageImages,
  extractMessageText,
  type RocketChatImageRef,
  type RocketChatRestMessage,
} from './rest-message.js';

const FETCH_TIMEOUT_MS = 8000;

const apiBase = (auth: RocketChatRestAuth) => `${auth.serverUrl.replace(/\/+$/, '')}/api/v1`;

/** POST JSON as the bot. `body` is undefined where the answer is not JSON. */
async function rcPost(
  auth: RocketChatRestAuth,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null | undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase(auth)}/${path}`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': auth.authToken,
        'X-User-Id': auth.userId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, body: undefined };
    const body = (await res.json().catch(() => undefined)) as
      | Record<string, unknown>
      | null
      | undefined;
    return { ok: true, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function rcGet(
  auth: RocketChatRestAuth,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase(auth)}/${path}?${qs}`, {
      headers: {
        'X-Auth-Token': auth.authToken,
        'X-User-Id': auth.userId,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    return body?.success === false ? null : body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type RoomEndpoints = readonly [string, string, string];
const HISTORY_ENDPOINTS: RoomEndpoints = ['channels.history', 'groups.history', 'im.history'];
const MESSAGES_ENDPOINTS: RoomEndpoints = ['channels.messages', 'groups.messages', 'im.messages'];
/** endpoint family + rid → the endpoint that worked last time. A room's type never changes, and
 *  probing costs a failed round-trip per fetch on private rooms (channels.* 404s), so remember the
 *  winner. Bounded by the rooms the bot is in. */
const endpointByRoom = new Map<string, string>();

/** Read a room's messages from whichever of the channel/group/direct endpoints answers, oldest-first. */
async function readRoomMessages(
  auth: RocketChatRestAuth,
  endpoints: RoomEndpoints,
  params: Record<string, string> & { roomId: string },
): Promise<RocketChatRestMessage[] | null> {
  const key = `${endpoints[0]} ${params.roomId}`;
  const cached = endpointByRoom.get(key);
  const order = cached ? [cached, ...endpoints.filter((e) => e !== cached)] : endpoints;
  for (const endpoint of order) {
    const raw = (await rcGet(auth, endpoint, params))?.messages;
    if (Array.isArray(raw)) {
      endpointByRoom.set(key, endpoint);
      return mapMessages(raw, auth.serverUrl);
    }
  }
  return null;
}

/**
 * Fetch up to `count` most-recent messages in a room, optionally older than
 * `before` (ISO timestamp). Returns messages OLDEST-FIRST. Empty array when the
 * room is unreachable (bad credential / bot not a member) — callers degrade to
 * no context rather than failing the turn.
 */
export async function fetchRoomHistory(
  auth: RocketChatRestAuth,
  rid: string,
  opts: { count: number; before?: string | undefined },
): Promise<RocketChatRestMessage[]> {
  const params = {
    roomId: rid,
    count: String(opts.count),
    ...(opts.before ? { latest: opts.before } : {}),
  };
  return (await readRoomMessages(auth, HISTORY_ENDPOINTS, params)) ?? [];
}

/** The `count` messages nearest to `ts` on one side of it, oldest-first. */
export async function fetchMessagesBeside(
  auth: RocketChatRestAuth,
  rid: string,
  ts: string,
  side: 'before' | 'after',
  count: number,
): Promise<RocketChatRestMessage[] | null> {
  return readRoomMessages(auth, MESSAGES_ENDPOINTS, {
    roomId: rid,
    count: String(count),
    query: JSON.stringify({ ts: { [side === 'after' ? '$gt' : '$lt']: { $date: ts } } }),
    sort: JSON.stringify({ ts: side === 'after' ? 1 : -1 }),
  });
}

interface RocketChatRoomInfo {
  rid: string;
  name: string;
  /** c = public channel, p = private group. */
  type: 'c' | 'p';
}

/**
 * List the rooms the BOT is a member of (public channels + private groups;
 * DMs/livechat excluded) — the candidate set for binding a project room,
 * since the bot must be a member to read/reply anyway. Empty array on any
 * failure (bad credential, unreachable server).
 */
export async function fetchBotRooms(auth: RocketChatRestAuth): Promise<RocketChatRoomInfo[]> {
  const body = await rcGet(auth, 'rooms.get', {});
  const raw = (body as { update?: unknown[] } | null)?.update;
  if (!Array.isArray(raw)) return [];
  const rooms: RocketChatRoomInfo[] = [];
  for (const r of raw) {
    const room = r as { _id?: string; t?: string; name?: string; fname?: string };
    if (typeof room._id !== 'string') continue;
    if (room.t !== 'c' && room.t !== 'p') continue;
    rooms.push({ rid: room._id, name: room.fname ?? room.name ?? room._id, type: room.t });
  }
  return rooms.sort((a, b) => a.name.localeCompare(b.name));
}

/** installation+rid → {name, type}; a room's name and type never change in practice, and the
 *  permalink builder runs on every mention. Bounded by the rooms the bot is in. */
const roomInfoByRid = new Map<string, { name: string | null; type: string }>();

async function roomInfo(auth: RocketChatRestAuth, rid: string) {
  const key = `${auth.serverUrl.replace(/\/+$/, '')} ${rid}`;
  const cached = roomInfoByRid.get(key);
  if (cached) return cached;
  const room = (
    (await rcGet(auth, 'rooms.info', { roomId: rid })) as {
      room?: { name?: string; t?: string };
    } | null
  )?.room;
  if (typeof room?.t !== 'string' || room.t.length === 0) return null;
  const info = { name: room.name || null, type: room.t };
  roomInfoByRid.set(key, info);
  return info;
}

/** A room's own `t` — `d` direct, `p` private group, `c` channel. A direct room usually has no name. */
export async function fetchRoomType(auth: RocketChatRestAuth, rid: string): Promise<string | null> {
  return (await roomInfo(auth, rid))?.type ?? null;
}

/**
 * Build a web permalink to a message in a room (`…/channel/<name>?msg=<id>`
 * for public, `…/group/<name>?msg=<id>` for private). Null when the room or its name can't be
 * resolved — the caller just omits the permalink line.
 */
export async function buildMessagePermalink(
  auth: RocketChatRestAuth,
  rid: string,
  messageId: string,
): Promise<string | null> {
  const info = await roomInfo(auth, rid);
  if (!info?.name) return null;
  const segment = info.type === 'p' ? 'group' : info.type === 'd' ? 'direct' : 'channel';
  return `${auth.serverUrl.replace(/\/+$/, '')}/${segment}/${info.name}?msg=${messageId}`;
}

/** The two names Rocket.Chat may show for the bot: its username, and the display name `UI_Use_Real_Name` swaps in. */
interface RocketChatOwnIdentity {
  username: string | null;
  displayName: string | null;
}

export async function fetchOwnIdentity(auth: RocketChatRestAuth): Promise<RocketChatOwnIdentity> {
  const body = (await rcGet(auth, 'me', {})) as { username?: unknown; name?: unknown } | null;
  const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return { username: text(body?.username), displayName: text(body?.name) };
}

/** Set or clear one reaction on a message, as the bot. */
export async function reactToMessage(
  auth: RocketChatRestAuth,
  messageId: string,
  emoji: string,
  on: boolean,
): Promise<boolean> {
  try {
    const res = await rcPost(auth, 'chat.react', { messageId, emoji, shouldReact: on });
    return res.ok && res.body?.success !== false;
  } catch {
    return false;
  }
}

/** One Rocket.Chat account as the server's own directory reports it. */
interface RocketChatUserProfile {
  externalId: string;
  username: string | null;
  email: string | null;
}

/**
 * ISS-977 — read a speaker's account from the server's directory, so the
 * address a link is proposed on comes from the channel rather than from
 * whoever is asking. Null when the bot cannot see the account: `users.info`
 * needs `view-full-other-user-info`, and a bot without it gets a 403 that is
 * indistinguishable here from an id that does not exist.
 */
export async function fetchUserProfile(
  auth: RocketChatRestAuth,
  externalId: string,
): Promise<RocketChatUserProfile | null> {
  const body = await rcGet(auth, 'users.info', { userId: externalId });
  const user = (body as { user?: Record<string, unknown> } | null)?.user;
  if (!user || typeof user._id !== 'string') return null;
  const emails = Array.isArray(user.emails)
    ? (user.emails as Array<{ address?: unknown; verified?: unknown }>)
    : [];
  const addresses = emails
    .filter((e) => typeof e?.address === 'string' && e.address.length > 0)
    .map((e) => ({ address: e.address as string, verified: e.verified === true }));
  const chosen = addresses.find((e) => e.verified) ?? addresses[0];
  return {
    externalId: user._id,
    username: typeof user.username === 'string' ? user.username : null,
    email: chosen?.address ?? null,
  };
}

/**
 * Fetch one message by id — used for a thread's ROOT message: RC's
 * `chat.getThreadMessages` returns the REPLIES only, so the message the
 * thread hangs off (usually the very thing a threaded mention refers to)
 * must be fetched separately. Null on any failure.
 */
export async function fetchMessage(
  auth: RocketChatRestAuth,
  msgId: string,
): Promise<RocketChatRestMessage | null> {
  const body = await rcGet(auth, 'chat.getMessage', { msgId });
  const raw = (body as { message?: RawRestMessage } | null)?.message;
  return raw ? mapMessage(raw, auth.serverUrl) : null;
}

/** Fetch a thread's messages (oldest-first). Null on any failure. */
export async function fetchThreadMessages(
  auth: RocketChatRestAuth,
  tmid: string,
  count: number,
): Promise<RocketChatRestMessage[] | null> {
  const raw = (await rcGet(auth, 'chat.getThreadMessages', { tmid, count: String(count) }))
    ?.messages;
  return Array.isArray(raw) ? mapMessages(raw, auth.serverUrl) : null;
}

export async function postRoomMessage(
  auth: RocketChatRestAuth,
  roomId: string,
  text: string,
  tmid?: string,
): Promise<string | null> {
  const res = await rcPost(auth, 'chat.postMessage', { roomId, text, ...(tmid ? { tmid } : {}) });
  if (!res.ok) throw new Error(`chat.postMessage failed with status ${res.status}`);
  if (res.body === undefined) throw new Error('chat.postMessage answered a body that is not JSON');
  if (res.body?.success === false) {
    throw new Error(
      `chat.postMessage rejected: ${(res.body.error as string | undefined) ?? 'unknown error'}`,
    );
  }
  const id = (res.body?.message as { _id?: unknown } | undefined)?._id;
  return typeof id === 'string' ? id : null;
}

/** Uploads are big and slow next to a JSON read; give them their own budget. */
const FILE_FETCH_TIMEOUT_MS = 20_000;

/**
 * Download an uploaded file's bytes with the bot credential.
 *
 * `maxBytes` is enforced against `content-length` BEFORE the body is read, so
 * an oversized upload costs a HEAD-shaped round-trip rather than a buffer the
 * process then throws away. Null on any failure — a picture the bot cannot
 * fetch degrades the answer, it never fails the turn.
 */
export async function fetchAttachmentBytes(
  auth: RocketChatRestAuth,
  ref: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ref, {
      headers: { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
