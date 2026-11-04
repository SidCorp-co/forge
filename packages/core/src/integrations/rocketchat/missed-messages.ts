// What a room missed while nothing answered it (ISS-933): its recent history, read in the shape the
// message stream carries, so a message replayed into a room is handled exactly as a live one is.

import { parseStreamMessage, type RocketChatIncomingMessage } from './ddp-client.js';
import { fetchRawRoomHistory, type RocketChatRestAuth } from './rest-client.js';

/**
 * Up to `count` most recent messages of a room newer than `oldest` (ISO), oldest first, with their
 * mentions, thread, quote and bot mark; null where the room cannot be read.
 */
export async function fetchRoomMessagesSince(
  auth: RocketChatRestAuth,
  rid: string,
  opts: { count: number; oldest: string },
): Promise<RocketChatIncomingMessage[] | null> {
  const raw = await fetchRawRoomHistory(auth, rid, opts);
  if (!raw) return null;
  return raw
    .map((m) => parseStreamMessage({ rid, ...(m as Record<string, unknown>) }, auth.serverUrl))
    .filter((m): m is RocketChatIncomingMessage => m !== null)
    .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
}
