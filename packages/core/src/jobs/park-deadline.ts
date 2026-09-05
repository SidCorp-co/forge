// The backstop for a park whose runner never came back.
//
// Phase 2 exempted `awaiting_input` from the heartbeat hop, which is right — a
// session waiting on a human is not wedged. But it left the park bounded by
// exactly one thing: the runner's own idle ceiling. If that runner dies while a
// session is parked, nothing on this side ever closes the row, and one of the
// box's few duplex slots is gone until someone notices by hand.
//
// This is NOT a policy knob. It fires only when the runner failed to honour its
// own deadline, which is why the bound is residency PLUS a grace — core and the
// runner racing to close the same park would make the reason a coin flip.
//
// One clock, two thresholds: `lastHeartbeatAt` freezes at the last real
// activity when a session parks (agent-sessions/routes.ts deliberately does not
// bump it on `awaiting_input`), so it already IS the park clock.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import type { LoopScope } from './loop-monitor.js';

// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/runner/claude_code.rs — this number and `SESSION_IDLE_TIMEOUT` are ONE value in two places, and `resolve_residency` there reads the same `sessionResidencySeconds` with the same rule: absent or 0 means this default, never zero residency. Diverge and core reaps a park the runner still considers live, at which point `residency_expired` stops meaning "the runner is gone".
const DEFAULT_RESIDENCY_SECONDS = 10 * 60;

// cm:guard a grace, not a tuning margin — it exists so the runner always closes its own park first and core only sees the ones it could not. Shrinking it toward zero makes the two sides race and the recorded failureReason stop meaning "the runner is gone".
const PARK_GRACE_SECONDS = 5 * 60;

// cm:guard `agent_sessions.project_id` written LITERALLY, and the column list of `projects` is read by name — drizzle renders a column reference inside a raw `sql` template unqualified, and an unqualified `project_id` here would resolve against `projects` first. A wrong JSON path does NOT fail: COALESCE swallows it and every project silently falls back to the default, which is why `park-deadline-e2e.test.ts` asserts a project that CONFIGURED a long residency is left alone.
const RESIDENCY_DEADLINE = sql`
  COALESCE(${agentSessions.lastHeartbeatAt}, ${agentSessions.createdAt})
    < now() - make_interval(secs => ${PARK_GRACE_SECONDS} + COALESCE((
        SELECT (p.agent_config -> 'pipelineConfig' ->> 'sessionResidencySeconds')::int
        FROM projects p WHERE p.id = agent_sessions.project_id
      ), ${DEFAULT_RESIDENCY_SECONDS}))`;

/**
 * Hop 3b — the residency deadline. A session parked past its runner's ceiling
 * plus a grace: the runner is presumed gone, so close the row and free the slot.
 */
// cm:guard a reason of its own, never `heartbeat_timeout` — this session did not miss a heartbeat, it was exempt from that clock by design, and recording the wrong cause sends whoever reads it to the runner logs for a stall that is not there.
export async function reapExpiredParks(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const reaped = await applyKernelTransition(db, {
    entity: 'session',
    to: 'failed',
    set: { failureReason: 'residency_expired', updatedAt: now },
    where: and(
      eq(agentSessions.status, 'running'),
      eq(agentSessions.runtimeState, 'awaiting_input'),
      RESIDENCY_DEADLINE,
      ...(scope.projectId ? [eq(agentSessions.projectId, scope.projectId)] : []),
    ),
    fromStatus: 'running',
    reason: 'residency_expired',
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });

  if (reaped.length > 0) {
    logger.info({ reaped: reaped.length }, 'loop-monitor: parks past their residency deadline');
  }
  return reaped.length;
}
