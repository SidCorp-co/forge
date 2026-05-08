import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import type { AgentSessionTurnRole } from '../db/schema.js';

interface SessionLite {
  id: string;
  projectId: string;
  deviceId: string | null;
  status: string;
}

/**
 * Publish a session-scoped event to both the project room and (when present)
 * the owning device room. Extracted from `routes.ts` so test files can spy on
 * the function and per-turn helpers can share the same fan-out logic.
 */
export function broadcastSession(
  session: SessionLite,
  event: string,
  extra: Record<string, unknown> = {},
): void {
  const payload = {
    event,
    data: {
      sessionId: session.id,
      projectId: session.projectId,
      deviceId: session.deviceId,
      status: session.status,
      ...extra,
    },
  };
  roomManager.publish(projectRoom(session.projectId), payload);
  if (session.deviceId) roomManager.publish(deviceRoom(session.deviceId), payload);
}

interface AppendedTurn {
  turnId: string;
  turnIndex: number;
  role: AgentSessionTurnRole;
}

// Per-session debouncer for streaming appends. The first append (new turn id)
// always fires immediately so the client learns the id; subsequent appends to
// the same turn coalesce into a tail-debounced 100ms broadcast to keep WS load
// manageable while the runner streams an assistant reply token-by-token.
//
// Single-process optimisation: the timer map is local to this Node process. In
// a multi-replica deploy, two replicas handling streaming PATCHes for the same
// session would each debounce independently — i.e. up to N broadcasts per
// 100ms window instead of one. That's still bounded and acceptable; if it ever
// matters, escalate the coalescing into the WS publish layer (Redis pub/sub or
// equivalent) so all replicas share a single tail timer per session.
const TAIL_DEBOUNCE_MS = 100;
const pendingTailBroadcast = new Map<string, NodeJS.Timeout>();

export function broadcastTurnAppended(
  session: SessionLite,
  turn: AppendedTurn,
  options: { isStreamingTail?: boolean } = {},
): void {
  const fire = () =>
    broadcastSession(session, 'agent-session.turn.appended', {
      turnId: turn.turnId,
      turnIndex: turn.turnIndex,
      role: turn.role,
    });

  if (!options.isStreamingTail) {
    // Cancel any pending tail debounce for this session — the new turn id is
    // a real append boundary, not a streaming continuation.
    const existing = pendingTailBroadcast.get(session.id);
    if (existing) {
      clearTimeout(existing);
      pendingTailBroadcast.delete(session.id);
    }
    fire();
    return;
  }

  // Streaming tail: replace any in-flight debounce with a fresh timer.
  const existing = pendingTailBroadcast.get(session.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTailBroadcast.delete(session.id);
    fire();
  }, TAIL_DEBOUNCE_MS);
  // Avoid keeping the event loop alive solely for a debounced broadcast in tests.
  if (typeof timer.unref === 'function') timer.unref();
  pendingTailBroadcast.set(session.id, timer);
}

export function broadcastTurnEdited(session: SessionLite, turnId: string): void {
  broadcastSession(session, 'agent-session.turn.edited', { turnId });
}

export function broadcastTurnTruncated(
  session: SessionLite,
  fromTurnIndex: number,
): void {
  broadcastSession(session, 'agent-session.turn.truncated', { fromTurnIndex });
}

/** Test hook — flush any pending streaming-append debounce timers. */
export function flushPendingTurnBroadcasts(): void {
  for (const t of pendingTailBroadcast.values()) clearTimeout(t);
  pendingTailBroadcast.clear();
}
