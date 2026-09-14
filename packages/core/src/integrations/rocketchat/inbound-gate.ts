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
// cm:guard these are about LOOPS and NOISE and apply to every room shape alike — a direct room relaxed only addressing, which no longer exists. Making one of them conditional would let the bot answer its own message, which is an unbounded loop with nothing left to stop it (ISS-987, ISS-1004).
export function decideSkip(
  msg: RocketChatIncomingMessage,
  botUserId: string,
): InboundSkipReason | null {
  if (msg.userId === botUserId) return 'own-message';
  if (msg.isSystem) return 'system';
  if (msg.isEdited) return 'edited';
  // cm:guard empty means NOTHING CARRIED, not blank text: a screenshot posted with no caption is a question, and dropping it here left the image out of the durable log entirely, so no window could ever be asked about it (ISS-1004, review pass 2 F6).
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
  // cm:guard the mark is a claim that this message is DURABLE somewhere, so a collect that rolled back must withdraw it: RC re-emits the same id after enrichment, and a mark left behind by a failed attempt turns that second delivery into a false duplicate — the message is then in no log and in no window, and nobody is owed an answer for a question that was asked (ISS-1004, review pass 2 F3).
  forget(id: string): void;
}

export function createSeenTracker(cap = 1000): SeenTracker {
  const seen = new Set<string>();
  const track = (id: string) => {
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
  track.forget = (id: string) => {
    seen.delete(id);
  };
  return track;
}
