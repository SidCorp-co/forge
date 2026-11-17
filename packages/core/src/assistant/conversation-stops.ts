/**
 * The turns this core runs right now, so a person can end one. Per-process and
 * not a table: a turn another core holds is refused here rather than pretended.
 */

import { interruptRunningTurn, sessionRowById } from '../agent-sessions/index.js';
import {
  listWindowsForConversation,
  readConversationAgentTurns,
  refuseConversation,
} from '../conversations/index.js';

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

function isTurnRunning(conversationId: string): boolean {
  return (inFlight.get(conversationId)?.size ?? 0) > 0;
}

/** End every turn this core runs here, and count them. */
function stopTurnsHere(conversationId: string): number {
  const held = inFlight.get(conversationId);
  if (!held || held.size === 0) return 0;
  const stopped = held.size;
  for (const controller of held) controller.abort(STOPPED_BY_A_PERSON);
  return stopped;
}

/**
 * End the turn this room is running, and count what was stopped: a turn this core holds, or the
 * Agent turn a paired box runs, interrupted as a session's Stop is (ISS-1268) — by whoever may
 * write the room, as before. A turn on another core, or none, is refused by name: answering
 * "stopped" over either tells the caller something this door never did.
 */
export async function stopConversationTurns(id: string): Promise<number> {
  const here = stopTurnsHere(id);
  if (here > 0) return here;

  const handed = (await readConversationAgentTurns(id, null)).filter(
    (t) => t.state === 'dispatched' || t.state === 'running',
  );
  let interrupted = 0;
  for (const turn of handed) {
    // a session deleted since the read has no turn left to stop, and is not counted as stopped
    const session = await sessionRowById(turn.sessionId);
    if (!session) continue;
    interruptRunningTurn(session);
    interrupted += 1;
  }
  if (interrupted > 0) return interrupted;

  const elsewhere = (await listWindowsForConversation(id, 5)).find(
    (w) => w.claimedAt !== null && w.closedAt === null && w.claimedBy !== null,
  );
  // A turn that registered during those reads is this core's to stop after all.
  if (isTurnRunning(id)) return stopTurnsHere(id);
  if (elsewhere) {
    throw refuseConversation(
      'CONVERSATION_TURN_ON_ANOTHER_CORE',
      `conversation ${id} has window ${elsewhere.id} still open under claim "${elsewhere.claimedBy}", and no turn for it is running on this core — a stop reaches only the core running the turn, so this one cannot end it`,
    );
  }

  throw refuseConversation(
    'CONVERSATION_NOTHING_RUNNING',
    `conversation ${id} is not answering anything right now, so there was nothing to stop`,
  );
}
