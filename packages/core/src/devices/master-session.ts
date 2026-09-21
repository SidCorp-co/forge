import {
  and,
  type Column,
  eq,
  getTableName,
  inArray,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';
import { LIVE_SESSION_STATUSES } from '../lifecycle/status-sets.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { announceOneShotRun, insertOneShotRun, type OneShotRunSpec } from '../pipeline/runs.js';

export { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';
export { liveMasterSessionId, masterSessionIfOwned } from './master-owner.js';

export interface MasterSession {
  sessionId: string;
  /** The terminal-multiplexer session name a human attaches to. */
  name: string;
  created: boolean;
}

/** The live master row for one (device, project), read through any executor. */
async function liveMasterOn(
  executor: Tx,
  args: { deviceId: string; projectId: string },
): Promise<{ id: string } | null> {
  const [row] = await executor
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.projectId, args.projectId),
        eq(agentSessions.kind, MASTER_SESSION_KIND),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The advisory-lock key two registrations for one (device, project) both compute. */
function masterLockKey(args: { deviceId: string; projectId: string }): SQL<number> {
  return sql<number>`hashtextextended(${`master-session:${args.deviceId}:${args.projectId}`}, 0)`;
}

/**
 * The live master session for one (device, project), creating it if there is
 * none.
 *
 * Idempotent by design: a daemon restart, a re-registration after a network
 * blip and a second sweep in the same minute all land on the same row, because
 * that row's id is what `jobs.held_by` and the children's
 * `agent_sessions.parent_session_id` carry.
 *
 * `agent_sessions_one_live_master_uq` makes that row single; the advisory lock
 * makes a concurrent registration WAIT and read the winner rather than raise.
 */
export async function ensureMasterSession(args: {
  deviceId: string;
  projectId: string;
  name: string;
}): Promise<MasterSession> {
  const live = await liveMasterOn(db, args);
  if (live) {
    await db
      .update(agentSessions)
      .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(agentSessions.id, live.id));
    return { sessionId: live.id, name: args.name, created: false };
  }

  const spec: OneShotRunSpec = {
    projectId: args.projectId,
    kind: 'system',
    metadata: { type: MASTER_SESSION_KIND, deviceId: args.deviceId },
  };
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${masterLockKey(args)})`);
    const winner = await liveMasterOn(tx, args);
    if (winner) return { existing: winner.id };
    const run = await insertOneShotRun(tx, spec);
    const [row] = await tx
      .insert(agentSessions)
      .values({
        projectId: args.projectId,
        deviceId: args.deviceId,
        pipelineRunId: run.id,
        title: `master: ${args.name}`,
        kind: MASTER_SESSION_KIND,
        status: 'running',
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        metadata: { terminalName: args.name, deviceId: args.deviceId },
      })
      .returning({ id: agentSessions.id });
    if (!row) throw new Error('ensureMasterSession: insert returned no row');
    return { opened: { sessionId: row.id, runId: run.id } };
  });

  if (claimed.existing) {
    await db
      .update(agentSessions)
      .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(agentSessions.id, claimed.existing));
    logger.info(
      { masterSessionId: claimed.existing, deviceId: args.deviceId, projectId: args.projectId },
      'master-session: a second registration arrived while the first was inserting, and it read the row the first wrote',
    );
    return { sessionId: claimed.existing, name: args.name, created: false };
  }

  const opened = claimed.opened;
  if (!opened) throw new Error('ensureMasterSession: the claim answered with neither row');
  await announceOneShotRun(opened.runId, spec);
  logger.info(
    {
      masterSessionId: opened.sessionId,
      deviceId: args.deviceId,
      projectId: args.projectId,
      name: args.name,
    },
    'master-session: registered a resident master',
  );
  return { sessionId: opened.sessionId, name: args.name, created: true };
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

/**
 * The outer table's own column, table-qualified. Interpolated bare, a drizzle
 * `Column` renders unqualified in a single-table select, and inside the
 * subquery below that name binds to the subquery's own row — a predicate true
 * for every row, answering every runner with the first master it finds.
 */
function outerRef(column: Column) {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

/**
 * Whether a device holds a live resident master for a project. A REGISTRATION
 * and not a pane: core cannot see tmux, so `lastHeartbeatAt` is all that
 * separates a master working now from a box gone quiet (ISS-1118).
 */
export function residentMasterSql(deviceIdColumn: Column, projectIdColumn: Column) {
  const device = outerRef(deviceIdColumn);
  const project = outerRef(projectIdColumn);
  return sql<{ sessionId: string; name: string; lastHeartbeatAt: string | null } | null>`(
    SELECT jsonb_build_object(
             'sessionId', s.id,
             'name', COALESCE(s.metadata->>'terminalName', ''),
             'lastHeartbeatAt', s.last_heartbeat_at
           )
      FROM ${agentSessions} s
     WHERE s.device_id = ${device}
       AND s.project_id = ${project}
       AND s.kind = ${MASTER_SESSION_KIND}
       AND s.status NOT IN (${sql.join(
         terminalAgentSessionStatuses.map((v) => sql`${v}`),
         sql`, `,
       )})
     ORDER BY s.started_at DESC NULLS LAST
     LIMIT 1
  )`;
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
        eq(agentSessions.kind, MASTER_SESSION_KIND),
        inArray(agentSessions.status, [...LIVE_SESSION_STATUSES]),
      ),
    );
  return rows.map((r) => ({
    sessionId: r.id,
    projectId: r.projectId,
    name: String((r.metadata as { terminalName?: unknown } | null)?.terminalName ?? ''),
  }));
}
