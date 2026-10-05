/**
 * The liveness probe and the ops health read, apart from the routes that serve
 * them (`health/routes.ts`).
 */

import { inArray, sql } from 'drizzle-orm';
import pkg from '../../package.json' with { type: 'json' };
import { db } from '../db/client.js';
import { agentSessions, projects, runners } from '../db/schema.js';
import { countInFlightByRunner } from '../jobs/index.js';
import { isWsListening } from '../lib/ws-listening.js';
import { isBossStarted } from '../queue/boss.js';

type LivenessSnapshot = {
  ok: boolean;
  dbOk: boolean;
  queueOk: boolean;
  wsOk: boolean;
};

/** Can the process reach its database, its queue, and its websocket listener? */
export async function readLiveness(): Promise<LivenessSnapshot> {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const queueOk = isBossStarted();
  const wsOk = isWsListening();
  return { ok: dbOk && queueOk && wsOk, dbOk, queueOk, wsOk };
}

type OpsRunner = {
  id: string;
  name: string | null;
  projectId: string;
  status: string;
  lastSeenAt: Date | null;
  inFlightCount: number;
};

type OpsStuckJob = {
  jobId: string;
  type: string;
  runnerId: string | null;
  dispatchedAt: string | null;
  ageSeconds: number;
};

const OPS_ROW_CAP = 50;

/**
 * The ops snapshot, scoped to the projects the caller can see.
 *
 * Every leg is guarded on `dbOk`: a snapshot whose whole purpose is to report
 * that the database is unreachable must not itself die trying to query it.
 */
export async function readOpsHealth(visibleProjectIds: string[], staleJobThresholdSeconds: number) {
  const { dbOk } = await readLiveness();
  const [runnersOut, projectsOut, stuckJobs] =
    dbOk && visibleProjectIds.length > 0
      ? await Promise.all([
          readOpsRunners(visibleProjectIds),
          readOpsProjects(visibleProjectIds),
          readStuckJobs(visibleProjectIds, staleJobThresholdSeconds),
        ])
      : [[], [], []];
  return {
    version: pkg.version,
    uptimeSeconds: Math.floor(process.uptime()),
    db: dbOk ? 'ok' : 'down',
    queue: isBossStarted() ? 'ok' : 'down',
    ws: isWsListening() ? 'ok' : 'down',
    runners: runnersOut,
    projects: projectsOut,
    stuckJobs,
    staleJobThresholdSeconds,
  };
}

async function readOpsRunners(projectIds: string[]): Promise<OpsRunner[]> {
  const rows = await db
    .select({
      id: runners.id,
      name: runners.name,
      projectId: runners.projectId,
      status: runners.status,
      lastSeenAt: runners.lastSeenAt,
    })
    .from(runners)
    .where(inArray(runners.projectId, projectIds));
  const inFlight = await countInFlightByRunner(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, inFlightCount: inFlight.get(r.id) ?? 0 }));
}

async function readOpsProjects(projectIds: string[]) {
  const rows = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      n: sql<number>`count(${agentSessions.id})::int`,
    })
    .from(projects)
    .leftJoin(
      agentSessions,
      sql`${agentSessions.projectId} = ${projects.id} AND ${agentSessions.status} IN ('queued','running')`,
    )
    .where(inArray(projects.id, projectIds))
    .groupBy(projects.id, projects.slug)
    .orderBy(sql`count(${agentSessions.id}) DESC`)
    .limit(OPS_ROW_CAP);
  return rows.map((r) => ({ id: r.id, slug: r.slug, activeJobCount: Number(r.n ?? 0) }));
}

async function readStuckJobs(projectIds: string[], staleSeconds: number): Promise<OpsStuckJob[]> {
  const rows = await db.execute<{
    id: string;
    type: string;
    runner_id: string | null;
    dispatched_at: string | null;
    age_seconds: string | number | null;
  }>(sql`
    SELECT id, type, runner_id, dispatched_at,
           EXTRACT(EPOCH FROM (now() - dispatched_at))::int AS age_seconds
    FROM jobs
    WHERE status = 'dispatched'
      AND dispatched_at IS NOT NULL
      AND dispatched_at < now() - (${staleSeconds}::int * interval '1 second')
      AND project_id IN (${sql.join(
        projectIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    ORDER BY dispatched_at ASC
    LIMIT ${OPS_ROW_CAP}
  `);
  return rows.map((r) => ({
    jobId: r.id,
    type: r.type,
    runnerId: r.runner_id,
    dispatchedAt: r.dispatched_at,
    ageSeconds: Number(r.age_seconds ?? 0),
  }));
}
