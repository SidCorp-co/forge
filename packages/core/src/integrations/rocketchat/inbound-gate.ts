/**
 * ISS-604 (P2d) — pure inbound-message gate for the Rocket.Chat bot.
 *
 * Kept dependency-free (type-only import) so it's unit-testable without booting
 * env/db. Decides whether an incoming room message should trigger a bot reply:
 * skip the bot's own messages (loop guard), system/edit events, empty text, and
 * anything that doesn't @-mention the bot (trigger-gating for noise + cost).
 */

import type { RocketChatIncomingMessage } from './ddp-client.js';

export function decideHandling(
  msg: RocketChatIncomingMessage,
  botUserId: string,
): { handle: boolean; reason: string } {
  if (msg.userId === botUserId) return { handle: false, reason: 'own-message' };
  if (msg.isSystem) return { handle: false, reason: 'system' };
  if (msg.isEdited) return { handle: false, reason: 'edited' };
  if (!msg.text.trim()) return { handle: false, reason: 'empty' };
  if (!msg.mentions.includes(botUserId)) return { handle: false, reason: 'not-mentioned' };
  return { handle: true, reason: 'ok' };
}

/**
 * Duplicate-delivery tracker. RC's `stream-room-messages` RE-EMITS a message
 * after server-side enrichment (URL previews on links/quotes) WITHOUT setting
 * `editedAt`, so a single mention arrives twice within ~50ms and — pre-fix —
 * produced two contradictory replies. Track recently seen message ids with a
 * FIFO cap so reconnect replays are also swallowed.
 */
export function createSeenTracker(cap = 1000): (id: string) => boolean {
  const seen = new Set<string>();
  return (id: string) => {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > cap) {
      // Set iterates in insertion order — drop the oldest fifth.
      const it = seen.values();
      for (let i = 0; i < cap / 5; i++) {
        const next = it.next();
        if (next.done) break;
        seen.delete(next.value);
      }
    }
    return false;
  };
}
