import type { AgentSessionKind, AgentSessionTurnRole } from '../db/schema.js';
import { publishEphemeral } from '../lib/ephemeral.js';
import { logger } from '../lib/logger.js';
import { pushSession } from './push.js';
import { sessionAudience } from './session-access.js';

interface SessionLite {
  id: string;
  projectId: string;
  deviceId: string | null;
  status: string;
  kind: AgentSessionKind;
  userId: string | null;
  metadata: unknown;
}

/**
 * The rooms a session's UI frame goes to: a project-wide session's project room and box room, or
 * only the rooms of a person's own chat's readers — never the project room, and never the box room,
 * which the box's owner may also read and the box itself does not consume.
 */
async function audienceOf(session: SessionLite) {
  const audience = await sessionAudience(session);
  return audience.projectWide
    ? { projectId: session.projectId, deviceId: session.deviceId, userIds: [] }
    : { projectId: null, deviceId: null, userIds: audience.userIds };
}

/**
 * Publish a session-scoped event to its audience (`audienceOf`). Extracted from `routes.ts` so
 * test files can spy on the function and per-turn helpers can share the same fan-out logic.
 */
export function broadcastSession(
  session: SessionLite,
  event: string,
  extra: Record<string, unknown> = {},
): void {
  void audienceOf(session)
    .then((audience) =>
      pushSession({
        ...audience,
        event,
        data: {
          sessionId: session.id,
          projectId: session.projectId,
          deviceId: session.deviceId,
          status: session.status,
          ...extra,
        },
      }),
    )
    .catch((err: unknown) =>
      logger.warn({ err, sessionId: session.id, event }, 'session push: the event was not written'),
    );
}

interface AppendedTurn {
  turnId: string;
  turnIndex: number;
  role: AgentSessionTurnRole;
}

const TAIL_DEBOUNCE_MS = 100;
const pendingTailBroadcast = new Map<string, NodeJS.Timeout>();

export function broadcastTurnAppended(
  session: SessionLite,
  turn: AppendedTurn,
  options: { isStreamingTail?: boolean } = {},
): void {
  // ephemeral (lib/ephemeral.ts): the turn row is stored; this ping only tells open views to refetch
  const fire = () =>
    void audienceOf(session)
      .then((audience) =>
        publishEphemeral(audience, {
          event: 'agent-session.turn.appended',
          data: {
            sessionId: session.id,
            projectId: session.projectId,
            deviceId: session.deviceId,
            status: session.status,
            turnId: turn.turnId,
            turnIndex: turn.turnIndex,
            role: turn.role,
          },
        }),
      )
      .catch((err: unknown) =>
        logger.warn({ err, sessionId: session.id }, 'turn-appended frame: no audience was read'),
      );

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

export function broadcastTurnTruncated(session: SessionLite, fromTurnIndex: number): void {
  broadcastSession(session, 'agent-session.turn.truncated', { fromTurnIndex });
}

/**
 * A turn-table sync, broadcast. The first new turn fires at once so the client
 * learns its id; later appends (a multi-block worker write) ride the tail
 * debouncer to keep WS load down while a runner streams a long reply.
 */
export function broadcastTurnSync(
  session: SessionLite,
  sync: { appended: readonly AppendedTurn[]; truncatedFromTurnIndex: number | null },
): void {
  for (const [i, t] of sync.appended.entries()) {
    broadcastTurnAppended(session, t, { isStreamingTail: i > 0 });
  }
  if (sync.truncatedFromTurnIndex !== null) {
    broadcastTurnTruncated(session, sync.truncatedFromTurnIndex);
  }
}
