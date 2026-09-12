/**
 * ISS-604 (P2d) — pure inbound-message gate for the Rocket.Chat bot.
 *
 * Kept dependency-free (type-only import) so it's unit-testable without booting
 * env/db. Decides whether an incoming room message should trigger a bot reply:
 * skip the bot's own messages (loop guard), system/edit events, empty text, and
 * — in a group room — anything that doesn't @-mention the bot (trigger-gating
 * for noise + cost).
 *
 * ISS-987 split the decision in two. The skips are facts about the message and
 * need no room; addressing is a fact about the room, so it needs the shape and
 * the shape needs a round trip.
 */

import type { RocketChatIncomingMessage } from './ddp-client.js';
import type { RoomShape } from './room-shape.js';

export type InboundSkipReason = 'own-message' | 'system' | 'edited' | 'empty';

/**
 * The skips that hold whatever room the message came from, so the caller can
 * drop a message before paying for its shape. Null when none of them applies.
 */
export function decideSkip(
  msg: RocketChatIncomingMessage,
  botUserId: string,
): InboundSkipReason | null {
  if (msg.userId === botUserId) return 'own-message';
  if (msg.isSystem) return 'system';
  if (msg.isEdited) return 'edited';
  if (!msg.text.trim()) return 'empty';
  return null;
}

// cm:guard the skips are about loops and noise and apply to a direct room exactly as they do to a channel — only ADDRESSING is what a direct room relaxes. Moving one of them under the `group` branch would let the bot answer its own message in a DM, which is an unbounded loop with no mention gate left to stop it (ISS-987).
export function decideHandling(
  msg: RocketChatIncomingMessage,
  botUserId: string,
  shape: RoomShape,
): { handle: boolean; reason: string } {
  const skip = decideSkip(msg, botUserId);
  if (skip) return { handle: false, reason: skip };
  // cm:why a person alone in a direct room with the bot has already addressed it by opening the room; requiring the bot's own name there is the mention gate applied where there is no noise to gate. A thread inside a direct room is still a direct room for addressing — what its `tmid` decides is which conversation the turn belongs to, not whether it runs.
  if (shape === 'direct') return { handle: true, reason: 'ok' };
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
      // cm:why Set iterates in INSERTION order per spec, which is what makes taking the first entries a drop of the oldest fifth rather than an arbitrary fifth
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
