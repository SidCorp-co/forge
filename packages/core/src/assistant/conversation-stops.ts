/**
 * The turns this core runs right now, so a person can end one. Per-process and
 * not a table: a turn another core holds is refused here rather than pretended.
 */

export const STOPPED_BY_A_PERSON = 'stopped-by-a-person';

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
