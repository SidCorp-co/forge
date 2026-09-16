/**
 * ISS-604 (P2d) — pure inbound-message gate for the Rocket.Chat bot.
 *
 * Kept dependency-free (type-only import) so it's unit-testable without booting
 * env/db. What is left of the gate is the loop guard and nothing else: the bot's
 * own messages, system and edit events, and empty text.
 *
 * ISS-1004 removed the @-mention requirement, and with it the whole notion of a
 * message being "addressed". A group-room message that named nobody used to be
 * dropped here, so a question asked without summoning anyone was never seen.
 * What bounds a room's cost now is the collector window and the three
 * proactivity guards (`conversations/windows.ts`, `conversations/proactivity.ts`)
 * — which is a replacement rather than an addition beside one, and why nothing
 * in this file reads `msg.mentions` any more.
 */

import type { RocketChatIncomingMessage } from './ddp-client.js';

export type InboundSkipReason = 'own-message' | 'system' | 'edited' | 'empty';

/**
 * The facts about a message that hold in any room it came from.
 */
export function decideSkip(
  msg: RocketChatIncomingMessage,
  botUserId: string,
): InboundSkipReason | null {
  if (msg.userId === botUserId) return 'own-message';
  if (msg.isSystem) return 'system';
  if (msg.isEdited) return 'edited';
  if (!msg.text.trim() && msg.images.length === 0) return 'empty';
  return null;
}

/**
 * Duplicate-delivery tracker. RC's `stream-room-messages` RE-EMITS a message
 * after server-side enrichment (URL previews on links/quotes) WITHOUT setting
 * `editedAt`, so a single mention arrives twice within ~50ms and — pre-fix —
 * produced two contradictory replies. Track recently seen message ids with a
 * FIFO cap so reconnect replays are also swallowed.
 */
export interface SeenTracker {
  /** True when this id has already been taken in. Marks it otherwise. */
  (id: string): boolean;
  /**
   * Take the mark back off an id whose work did not survive.
   */
  forget(id: string): void;
}

export function createSeenTracker(cap = 1000): SeenTracker {
  const seen = new Set<string>();
  const track = (id: string) => {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > cap) {
      const it = seen.values();
      for (let i = 0; i < cap / 5; i++) {
        const next = it.next();
        if (next.done) break;
        seen.delete(next.value);
      }
    }
    return false;
  };
  track.forget = (id: string) => {
    seen.delete(id);
  };
  return track;
}
