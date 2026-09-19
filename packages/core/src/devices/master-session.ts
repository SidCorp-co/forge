import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { openOneShotRun } from '../pipeline/runs.js';

/** What `metadata.type` a master session carries. */
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
        sql`${agentSessions.metadata}->>'type' = ${MASTER_SESSION_TYPE}`,
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    )
    .limit(1);
  if (live) {
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
