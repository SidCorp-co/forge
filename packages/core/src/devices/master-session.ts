import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { and, type Column, eq, getTableName, notInArray, sql } from 'drizzle-orm';
import { beatSession, insertSessionRow, transitionSessions } from '../agent-sessions/index.js';
import { db, type Tx } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { insertOneShotRun, type OneShotRunSpec } from '../pipeline/index.js';

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

/**
 * Whether `sessionId` is a master session core issued to this box (of `projectId` where given),
 * and, with `live`, one that has not ended.
 */
export async function masterSessionOnDevice(args: {
  deviceId: string;
  sessionId: string;
  projectId?: string;
  live: boolean;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.kind, MASTER_SESSION_KIND),
        args.projectId ? eq(agentSessions.projectId, args.projectId) : undefined,
        args.live ? notInArray(agentSessions.status, [...terminalAgentSessionStatuses]) : undefined,
      ),
    )
    .limit(1);
  return row !== undefined;
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
    await beatSession(live.id);
    return { sessionId: live.id, name: args.name, created: false };
  }

  const spec: OneShotRunSpec = {
    projectId: args.projectId,
    kind: 'system',
    metadata: { type: MASTER_SESSION_KIND, deviceId: args.deviceId },
  };
  const claimed = await db.transaction(async (tx) => {
    await lockXact(tx, 'masterSession', `${args.deviceId}:${args.projectId}`);
    const winner = await liveMasterOn(tx, args);
    if (winner) return { existing: winner.id };
    const run = await insertOneShotRun(tx, spec);
    const row = await insertSessionRow(tx, {
      projectId: args.projectId,
      deviceId: args.deviceId,
      pipelineRunId: run.id,
      title: `master: ${args.name}`,
      kind: MASTER_SESSION_KIND,
      status: 'running',
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      metadata: { terminalName: args.name, deviceId: args.deviceId },
    });
    return { opened: { sessionId: row.id, runId: run.id } };
  });

  if (claimed.existing) {
    await beatSession(claimed.existing);
    logger.info(
      { masterSessionId: claimed.existing, deviceId: args.deviceId, projectId: args.projectId },
      'master-session: a second registration arrived while the first was inserting, and it read the row the first wrote',
    );
    return { sessionId: claimed.existing, name: args.name, created: false };
  }

  const opened = claimed.opened;
  if (!opened) throw new Error('ensureMasterSession: the claim answered with neither row');
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
  const rows = (
    await transitionSessions(db, {
      to: 'completed',
      set: { failureDetail: args.reason, updatedAt: new Date() },
      where: and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.kind, MASTER_SESSION_KIND),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
      reason: 'master_session_ended',
      actor: { type: 'system' },
      source: 'master-session',
    })
  ).rows;
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
