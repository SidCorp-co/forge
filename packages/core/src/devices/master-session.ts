/**
 * The master as a session core knows about (ISS-919 B1).
 *
 * Before this, a master was a bare `claude -p` process that invented its own
 * session id: core had no record it ever existed, `jobs.held_by` pointed at
 * nothing, and the reaper's LEFT JOIN fell through to judging holds by age
 * alone. A resident master registers here once and keeps that row for as long
 * as it lives, so its identity, its liveness and its judgement all have
 * somewhere to be.
 *
 * The row IS the bound. One live master per (device, project) is enforced by
 * this lookup rather than by the runner's in-process map, because the map
 * cannot see a session whose parent is the terminal multiplexer rather than
 * the daemon — which is exactly what B1 asks for.
 */

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { openOneShotRun } from '../pipeline/runs.js';

/** What `metadata.type` a master session carries. */
// cm:guard the discriminator is `metadata.type`, the same key chat and pipeline sessions use, so every existing reader that partitions on it keeps working and a master shows up in the project's session list rather than in a private table nobody looks at.
export const MASTER_SESSION_TYPE = 'master';

export interface MasterSession {
  sessionId: string;
  /** The terminal-multiplexer session name a human attaches to. */
  name: string;
  created: boolean;
}

/**
 * The live master session for one (device, project), creating it if there is
 * none.
 *
 * Idempotent by design: a daemon restart, a re-registration after a network
 * blip and a second sweep in the same minute must all land on the same row,
 * because that row's id is what `jobs.held_by` already carries.
 */
// cm:guard the reuse lookup filters on NON-TERMINAL status, never on "most recent". A master that ended is a master that must be replaced, and handing its id back would have the runner report liveness onto a closed row while the pool watched a session that will never claim again.
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/daemon/master.rs — `name` is the tmux session name the runner derived, and it round-trips unchanged so an operator reading the row in the UI can type `tmux attach -t <name>` on the box and reach the process. Deriving a second name here would give the same master two handles and make neither of them checkable.
export async function ensureMasterSession(args: {
  deviceId: string;
  projectId: string;
  name: string;
}): Promise<MasterSession> {
  const [live] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.projectId, args.projectId),
        // cm:guard the type filter belongs in the WHERE, not in a post-filter on the first row. This device runs the project's pipeline agents too, and a `LIMIT 1` that reads one of THOSE and then rejects it by type would create a second master on every sweep — the exact duplication B1 exists to prevent, arriving through the reuse path.
        sql`${agentSessions.metadata}->>'type' = ${MASTER_SESSION_TYPE}`,
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    )
    .limit(1);
  if (live) {
    // cm:guard the reuse path MUST bump the heartbeat, and this is the only thing that does. The runner re-registers every sweep precisely so a living master keeps beating; without this write `reapDeadMasterHolds` releases a healthy master's holds after three minutes of it working perfectly, and the master then starts a second agent on work core has already offered to somebody else.
    await db
      .update(agentSessions)
      .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(agentSessions.id, live.id));
    return { sessionId: live.id, name: args.name, created: false };
  }

  const run = await openOneShotRun({
    projectId: args.projectId,
    kind: 'system',
    metadata: { type: MASTER_SESSION_TYPE, deviceId: args.deviceId },
  });
  const [row] = await db
    .insert(agentSessions)
    .values({
      projectId: args.projectId,
      deviceId: args.deviceId,
      pipelineRunId: run.id,
      title: `master: ${args.name}`,
      status: 'running',
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      metadata: { type: MASTER_SESSION_TYPE, terminalName: args.name, deviceId: args.deviceId },
    })
    .returning({ id: agentSessions.id });
  if (!row) throw new Error('ensureMasterSession: insert returned no row');
  logger.info(
    {
      masterSessionId: row.id,
      deviceId: args.deviceId,
      projectId: args.projectId,
      name: args.name,
    },
    'master-session: registered a resident master',
  );
  return { sessionId: row.id, name: args.name, created: true };
}

/**
 * Close a master session the runner has observed die, and say why.
 *
 * The holds are NOT released here — `releaseHoldsForSession` owns that and the
 * runner calls it on the same path. Two writes, deliberately: a status is what
 * the reaper reads, a hold is what the pool reads, and folding them into one
 * statement would make a partial failure invisible on whichever half lost.
 */
// cm:guard refuse to close a session this device does not own. Every paired runner in the fleet holds a valid device token, so without the ownership check any box could terminate another box's master and take its work — the same reason `assertOwnsSession` exists on the inbox routes.
// cm:edge lockstep -> packages/core/src/lifecycle/transition.ts — route this flip through `applyKernelTransition` so it leaves a `kernel_transitions` row like every other. `transition-guard.test.ts` caught this one while ISS-919 was being written, which is the whole reason the guard scans the tree rather than the diff. It is NOT true that every terminal `agent_sessions` write goes through the chokepoint — the runner's `PATCH /:id` is a direct `db.update` the guard cannot see, because it writes a variable status (ISS-927). That is a fact about the guard's reach, not a licence: a LITERAL terminal status here still fails the build, and should.
export async function closeMasterSession(args: {
  deviceId: string;
  sessionId: string;
  reason: string;
}): Promise<boolean> {
  const rows = await applyKernelTransition(db, {
    entity: 'session',
    to: 'completed',
    set: { failureDetail: args.reason, updatedAt: new Date() },
    where: and(
      eq(agentSessions.id, args.sessionId),
      eq(agentSessions.deviceId, args.deviceId),
      notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
    ),
    fromStatus: 'running',
    reason: 'master_session_ended',
    actor: { type: 'system' },
    source: 'master-session',
  });
  return rows.length > 0;
}

/** Every live master session on one device, for the daemon's own reconcile. */
export async function listMasterSessionsForDevice(
  deviceId: string,
): Promise<Array<{ sessionId: string; projectId: string; name: string }>> {
  const rows = await db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      metadata: agentSessions.metadata,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.deviceId, deviceId),
        inArray(agentSessions.status, ['idle', 'queued', 'running']),
      ),
    );
  return rows
    .filter((r) => (r.metadata as { type?: unknown } | null)?.type === MASTER_SESSION_TYPE)
    .map((r) => ({
      sessionId: r.id,
      projectId: r.projectId,
      name: String((r.metadata as { terminalName?: unknown } | null)?.terminalName ?? ''),
    }));
}
