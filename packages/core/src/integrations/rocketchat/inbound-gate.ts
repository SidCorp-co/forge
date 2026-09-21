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
