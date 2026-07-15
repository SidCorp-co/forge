/**
 * ISS-609 (Lane A intelligence) — minimal Rocket.Chat REST reader.
 *
 * Fetches room history + thread messages with the same bot credential the DDP
 * client uses (X-Auth-Token / X-User-Id headers). Room-type-agnostic: RC splits
 * history across channels.history (public) / groups.history (private) /
 * im.history (DM), so we probe them in order and use the first that succeeds.
 * Read-only; used to seed the chat turn's conversation context and to back the
 * bounded `rocketchat_history` chat tool.
 */

export interface RocketChatRestAuth {
  /** e.g. https://chat.sidcorp.co */
  serverUrl: string;
  authToken: string;
  userId: string;
}

/** Simplified REST message (both history + thread endpoints map to this). */
export interface RocketChatRestMessage {
  id: string;
  text: string;
  userId: string;
  username: string;
  /** ISO timestamp. */
  ts: string;
  isSystem: boolean;
}

const FETCH_TIMEOUT_MS = 8000;

interface RawRestMessage {
  _id?: string;
  msg?: string;
  ts?: string;
  t?: string;
  u?: { _id?: string; username?: string };
  attachments?: Array<{
    title?: string;
    text?: string;
    description?: string;
    title_link?: string;
    message_link?: string;
  }>;
}

/**
 * A message's real content may live entirely in `attachments[]` — webhook/bot
 * notifications (and the quoted block of a reply) post with an EMPTY `msg`.
 * Flatten attachment title/text/description into the text so the conversation
 * seed and the history tool actually see what the channel saw. The title's
 * link is kept inline — a webhook card's URL is often the ONLY place the
 * source entity's id appears (e.g. `…/tasks?projectId=53&task=12608`).
 */
export function extractMessageText(raw: Pick<RawRestMessage, 'msg' | 'attachments'>): string {
  const parts: string[] = [];
  if (typeof raw.msg === 'string' && raw.msg.length > 0) parts.push(raw.msg);
  for (const a of raw.attachments ?? []) {
    const title = [a.title, a.title_link ? `(${a.title_link})` : null]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .join(' ');
    for (const field of [title, a.text, a.description, a.message_link]) {
      if (typeof field === 'string' && field.trim().length > 0) parts.push(field);
    }
  }
  return parts.join('\n');
}

function mapMessage(raw: RawRestMessage): RocketChatRestMessage | null {
  if (!raw || typeof raw._id !== 'string' || !raw.u?._id) return null;
  return {
    id: raw._id,
    text: extractMessageText(raw),
    userId: raw.u._id,
    username: raw.u.username ?? raw.u._id,
    ts: typeof raw.ts === 'string' ? raw.ts : '',
    isSystem: typeof raw.t === 'string' && raw.t.length > 0,
  };
}

async function rcGet(
  auth: RocketChatRestAuth,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const base = auth.serverUrl.replace(/\/+$/, '');
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/v1/${path}?${qs}`, {
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

const HISTORY_ENDPOINTS = ['channels.history', 'groups.history', 'im.history'] as const;
/** rid → the history endpoint that worked last time. A room's type never
 *  changes, and probing costs a failed round-trip per fetch on private rooms
 *  (channels.history 404s), so remember the winner. Bounded by the rooms the
 *  bot is in. */
const endpointByRoom = new Map<string, string>();

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
  const params: Record<string, string> = { roomId: rid, count: String(opts.count) };
  if (opts.before) params.latest = opts.before;
  const cached = endpointByRoom.get(rid);
  const order = cached
    ? [cached, ...HISTORY_ENDPOINTS.filter((e) => e !== cached)]
    : [...HISTORY_ENDPOINTS];
  for (const endpoint of order) {
    const body = await rcGet(auth, endpoint, params);
    const raw = body?.messages;
    if (Array.isArray(raw)) {
      endpointByRoom.set(rid, endpoint);
      const mapped = raw
        .map((m) => mapMessage(m as RawRestMessage))
        .filter((m): m is RocketChatRestMessage => m !== null);
      // History endpoints return newest-first; flip to chronological.
      return mapped.sort((a, b) => a.ts.localeCompare(b.ts));
    }
  }
  return [];
}

export interface RocketChatRoomInfo {
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

/** rid → {name, type}; a room's name/type never change in practice, and the
 *  permalink builder runs on every mention. Bounded by the rooms the bot is in. */
const roomInfoByRid = new Map<string, { name: string; type: string }>();

/**
 * Build a web permalink to a message in a room (`…/channel/<name>?msg=<id>`
 * for public, `…/group/<name>?msg=<id>` for private). Room name comes from
 * `rooms.info` (cached per rid). Null when the room can't be resolved — the
 * caller just omits the permalink line.
 */
export async function buildMessagePermalink(
  auth: RocketChatRestAuth,
  rid: string,
  messageId: string,
): Promise<string | null> {
  let info = roomInfoByRid.get(rid);
  if (!info) {
    const body = await rcGet(auth, 'rooms.info', { roomId: rid });
    const room = (body as { room?: { name?: string; t?: string } } | null)?.room;
    if (!room?.name || typeof room.t !== 'string') return null;
    info = { name: room.name, type: room.t };
    roomInfoByRid.set(rid, info);
  }
  const segment = info.type === 'p' ? 'group' : info.type === 'd' ? 'direct' : 'channel';
  return `${auth.serverUrl.replace(/\/+$/, '')}/${segment}/${info.name}?msg=${messageId}`;
}

/** The bot account's own username (api/v1/me) — lets the bot speak about
 *  itself by name instead of as "the system". Null on failure. */
export async function fetchOwnUsername(auth: RocketChatRestAuth): Promise<string | null> {
  const body = await rcGet(auth, 'me', {});
  const username = (body as { username?: string } | null)?.username;
  return typeof username === 'string' && username.length > 0 ? username : null;
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
  return raw ? mapMessage(raw) : null;
}

/** Fetch a thread's messages (oldest-first). Empty array on any failure. */
export async function fetchThreadMessages(
  auth: RocketChatRestAuth,
  tmid: string,
  count: number,
): Promise<RocketChatRestMessage[]> {
  const body = await rcGet(auth, 'chat.getThreadMessages', { tmid, count: String(count) });
  const raw = body?.messages;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => mapMessage(m as RawRestMessage))
    .filter((m): m is RocketChatRestMessage => m !== null)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * ISS-675 — post a message to a room via REST (as opposed to the DDP
 * `sendMessage` the live bot socket uses). The async escalation completion
 * bridge is NOT tied to any live DDP connection's request/response cycle —
 * it fires from a session-terminal transition, which may happen on a
 * different core instance than the one holding the DDP socket — so it
 * rebuilds auth from the stored connection secrets and posts over REST
 * instead. Throws on a non-ok response or an RC-level `success: false` so the
 * caller can log/report the failure; it does not retry.
 */
export async function postRoomMessage(
  auth: RocketChatRestAuth,
  roomId: string,
  text: string,
  tmid?: string,
): Promise<void> {
  const base = auth.serverUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/v1/chat.postMessage`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': auth.authToken,
        'X-User-Id': auth.userId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ roomId, text, ...(tmid ? { tmid } : {}) }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`chat.postMessage failed with status ${res.status}`);
    const body = (await res.json()) as { success?: boolean; error?: string };
    if (body?.success === false) {
      throw new Error(`chat.postMessage rejected: ${body.error ?? 'unknown error'}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
