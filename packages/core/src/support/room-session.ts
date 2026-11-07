// Which session a room's turn is handed to (ISS-1101). A room's session that ended, failed or
// cancelled, is never handed another turn: the room lets go of it and the turn goes to a new one,
// which runs in the checkout the binding names then. One that ended on a cause the same checkout
// meets again (it is not on the box, or the box has no program to run in it) is not replaced while
// the binding still names that checkout: the room holds, and the thread is told by the failed-turn
// path. The binding naming another checkout, a binding saved or a box coming online lifts the hold.
//
// Replaces the rule that a room's one session took every turn whatever its status: epod's channel
// agent session 90306f67 failed every start in a checkout its box no longer had, and the warm sweep
// and its messages' re-offers handed it 1,086 more, every one lost.

import type { FailureCause } from '@forge/contracts/failure-causes';
import type { AgentSessionStatus } from '@forge/contracts/session-machine';
import { sessionRowById } from '../agent-sessions/index.js';
import type { agentSessions } from '../db/schema.js';
import { findBindingWithConnectionById } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { resolveSessionRepoPathForDevice } from '../lib/device-pool.js';
import { logger } from '../lib/logger.js';
import { ensureSupportRoom, letGoOfEndedSession, roomIsBound } from './rooms.js';
import { type RoomRow, roomById } from './store.js';

export type SessionRow = typeof agentSessions.$inferSelect;

export async function sessionOf(room: RoomRow): Promise<SessionRow | null> {
  return room.sessionId ? sessionRowById(room.sessionId) : null;
}

/**
 * The room as it stands, its session declared if its binding is on and still names it as it was
 * declared. A room its binding no longer answers gets none: the sweep released it (ISS-933).
 */
export async function roomWithSession(roomId: string): Promise<RoomRow | null> {
  const room = await roomById(roomId);
  if (!room || room.sessionId || !(await roomIsBound(room))) return room;
  const pair = await findBindingWithConnectionById(room.bindingId);
  const config = (pair?.binding.config ?? null) as RocketChatBindingConfig | null;
  const declared =
    room.kind === 'operations'
      ? config?.operations
        ? ({ kind: 'operations', scope: config.operations.scope } as const)
        : null
      : room.kind === 'agent'
        ? config?.agent
          ? ({ kind: 'agent', agent: config.agent } as const)
          : null
        : config?.support
          ? ({ kind: 'support', support: config.support } as const)
          : null;
  if (!declared) return room;
  return ensureSupportRoom({
    projectId: room.projectId,
    bindingId: room.bindingId,
    connectionId: room.connectionId,
    rid: room.rid,
    room: declared,
  });
}

/** The ends a room's session takes no turn after. */
const ENDED: ReadonlySet<AgentSessionStatus> = new Set(['failed', 'cancelled', 'cancelled_stale']);

/**
 * The causes a turn ends on that a retry in the same checkout meets again, so the room does not
 * try: a checkout that is not on the box (`workspace_preflight_failed`, the runner's refusal of a
 * gone checkout), or no program on the box to run in it (`runner_unsupported_type`).
 */
const CAUSES_THAT_STAND: ReadonlySet<FailureCause> = new Set([
  'workspace_preflight_failed',
  'runner_unsupported_type',
]);

/**
 * What a room does with its session: hand it the turn (`live`), let it go and hand the turn to a
 * new one (`replace`), or hand nothing (`hold`) while it ended on a cause that stands in the
 * checkout the binding still names. `lift` is a person's act that may have cleared the cause.
 */
export function standingOf(
  session: Pick<SessionRow, 'status' | 'failureReason' | 'repoPath'>,
  bindingPath: string | null,
  lift = false,
): 'live' | 'replace' | 'hold' {
  if (!ENDED.has(session.status)) return 'live';
  const stands = session.failureReason !== null && CAUSES_THAT_STAND.has(session.failureReason);
  if (stands && !lift && bindingPath !== null && bindingPath === session.repoPath) return 'hold';
  return 'replace';
}

/** The room and the session its turn goes to; `held` is the ended session it waits behind. */
export interface Placed {
  room: RoomRow;
  session: SessionRow | null;
  held: SessionRow | null;
}

/** The session a turn of `room` is handed to, an ended one let go of first (see the head). */
export async function sessionToHand(room: RoomRow, opts: { lift?: boolean } = {}): Promise<Placed> {
  const session = await sessionOf(room);
  if (!session) return { room, session: null, held: null };
  const bindingPath = session.deviceId
    ? await resolveSessionRepoPathForDevice(room.projectId, session.deviceId)
    : null;
  const standing = standingOf(session, bindingPath, opts.lift);
  if (standing === 'live') return { room, session, held: null };
  if (standing === 'hold') return { room, session: null, held: session };
  await letGoOfEndedSession(room, session.id);
  logger.info(
    {
      roomId: room.id,
      sessionId: session.id,
      status: session.status,
      failureReason: session.failureReason,
      from: session.repoPath,
      to: bindingPath,
    },
    "support: the room's session ended; it takes no more turns, and the next goes to a new session",
  );
  const placed = (await roomWithSession(room.id)) ?? room;
  return { room: placed, session: await sessionOf(placed), held: null };
}
