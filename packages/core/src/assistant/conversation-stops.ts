/**
 * The turns this core runs right now, so a person can end one. Per-process and
 * not a table: a turn another core holds is refused here rather than pretended.
 */

import {
  listWindowsForConversation,
  readConversationAgentTurns,
  refuseConversation,
} from '../conversations/index.js';
import type { RefusalError } from '../lib/refusal.js';

export const STOPPED_BY_A_PERSON = 'stopped-by-a-person';

/** The abort reason of a turn that ran past its ceiling, so its end reads as a timeout and not as a crash. */
export const TURN_TIMED_OUT = 'turn-timed-out';

const inFlight = new Map<string, Set<AbortController>>();

export interface TurnStopHandle {
  signal: AbortSignal;
  release: () => void;
}

export function registerTurnStop(conversationId: string): TurnStopHandle {
  const controller = new AbortController();
  const held = inFlight.get(conversationId) ?? new Set<AbortController>();
  held.add(controller);
  inFlight.set(conversationId, held);
  return {
    signal: controller.signal,
    release: () => {
      const set = inFlight.get(conversationId);
      if (!set) return;
      set.delete(controller);
      if (set.size === 0) inFlight.delete(conversationId);
    },
  };
}

export function isTurnRunning(conversationId: string): boolean {
  return (inFlight.get(conversationId)?.size ?? 0) > 0;
}

/** End every turn this core runs here, and count them. Zero is what a caller refuses on. */
export function stopConversationTurns(conversationId: string): number {
  const held = inFlight.get(conversationId);
  if (!held || held.size === 0) return 0;
  const stopped = held.size;
  for (const controller of held) controller.abort(STOPPED_BY_A_PERSON);
  return stopped;
}

/**
 * Why this core cannot stop this room's turn. The registry is this process's
 * own, so the turn may be a paired box's or another core's, and answering
 * "idle" to either tells the caller something this door never read.
 */
export async function nothingHereToStop(id: string): Promise<RefusalError | null> {
  const handed = (await readConversationAgentTurns(id, null)).find(
    (t) => t.state === 'dispatched' || t.state === 'running',
  );
  if (handed) {
    return refuseConversation(
      'CONVERSATION_TURN_HANDED_OFF',
      `conversation ${id} handed this turn to a paired box, so there is nothing here to stop — end agent session ${handed.sessionId} instead`,
    );
  }

  const elsewhere = (await listWindowsForConversation(id, 5)).find(
    (w) => w.claimedAt !== null && w.closedAt === null && w.claimedBy !== null,
  );
  // A turn that registered during those reads is this core's to stop after all.
  if (isTurnRunning(id)) return null;
  if (elsewhere) {
    return refuseConversation(
      'CONVERSATION_TURN_ON_ANOTHER_CORE',
      `conversation ${id} has window ${elsewhere.id} still open under claim "${elsewhere.claimedBy}", and no turn for it is running on this core — a stop reaches only the core running the turn, so this one cannot end it`,
    );
  }

  return refuseConversation(
    'CONVERSATION_NOTHING_RUNNING',
    `conversation ${id} is not answering anything right now, so there was nothing to stop`,
  );
}
