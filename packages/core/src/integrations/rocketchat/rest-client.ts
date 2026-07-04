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
  attachments?: Array<{ title?: string; text?: string; description?: string }>;
}

/**
 * A message's real content may live entirely in `attachments[]` — webhook/bot
 * notifications (and the quoted block of a reply) post with an EMPTY `msg`.
 * Flatten attachment title/text/description into the text so the conversation
 * seed and the history tool actually see what the channel saw.
 */
export function extractMessageText(raw: Pick<RawRestMessage, 'msg' | 'attachments'>): string {
  const parts: string[] = [];
  if (typeof raw.msg === 'string' && raw.msg.length > 0) parts.push(raw.msg);
  for (const a of raw.attachments ?? []) {
    for (const field of [a.title, a.text, a.description]) {
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
