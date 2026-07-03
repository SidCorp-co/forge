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
  for (const endpoint of ['channels.history', 'groups.history', 'im.history']) {
    const body = await rcGet(auth, endpoint, params);
    const raw = body?.messages;
    if (Array.isArray(raw)) {
      const mapped = raw
        .map((m) => mapMessage(m as RawRestMessage))
        .filter((m): m is RocketChatRestMessage => m !== null);
      // History endpoints return newest-first; flip to chronological.
      return mapped.sort((a, b) => a.ts.localeCompare(b.ts));
    }
  }
  return [];
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
