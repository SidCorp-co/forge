import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns, projectMembers, projects, runners, users } from '../db/schema.js';
import { createLimiter } from '../lib/bounded-concurrency.js';
import { firstShipped } from '../pipeline/shipped-at.js';

/**
 * The ten independent per-project reads behind `GET /api/projects/health`, and
 * the bound they run under. They were awaited one after another until ISS-1018;
 * the figures are unchanged and the latency is now three waves rather than ten
 * round trips.
 */

export const HEALTH_READ_CONCURRENCY = 4;
const healthReadLimiter = createLimiter(HEALTH_READ_CONCURRENCY);

/** In flight and parked, for the test that asserts the bound holds. */
export const healthReadLoad = {
  get inFlight() {
    return healthReadLimiter.inFlight;
  },
  get waiting() {
    return healthReadLimiter.waiting;
  },
};

export const BLOCKED_STATUSES = ['on_hold', 'needs_info'] as const;

export type BlockerRow = {
  projectId: string;
  id: string;
  issSeq: number;
  issuePrefix: string | null;
  status: string;
};

function idList(projectIds: string[]) {
  return sql.join(
    projectIds.map((id) => sql`${id}`),
    sql`, `,
  );
}

const readStatusRows = (projectIds: string[]) =>
  db
    .select({
      projectId: issues.projectId,
      status: issues.status,
      n: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(inArray(issues.projectId, projectIds))
    .groupBy(issues.projectId, issues.status);

const readBlockerRows = (projectIds: string[]) =>
  db
    .select({
      projectId: issues.projectId,
      id: issues.id,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      status: issues.status,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(
      and(inArray(issues.projectId, projectIds), inArray(issues.status, [...BLOCKED_STATUSES])),
    )
    .orderBy(issues.projectId, sql`${issues.updatedAt} DESC`);

export type ThroughputRow = { projectId: string; n: number };

const lastSevenDays = (projectIds: string[]) =>
  firstShipped({ projectIds, from: sql`now() - interval '7 days'` });

const readThroughputRows = (projectIds: string[]) =>
  db.execute(sql`
    SELECT f.project_id AS "projectId", count(*)::int AS n
    FROM (${lastSevenDays(projectIds)}) f
    GROUP BY f.project_id
  `) as unknown as Promise<ThroughputRow[]>;

export type CycleRow = { project_id: string; avg_days: number | null };

const readCycleRows = (projectIds: string[]) =>
  db.execute(sql`
    WITH completions AS (
      SELECT f.issue_id, f.shipped_at, f.project_id, i.created_at AS issue_created_at
      FROM (${lastSevenDays(projectIds)}) f
      JOIN issues i ON i.id = f.issue_id
    ),
    work_start AS (
      SELECT DISTINCT ON (al.issue_id) al.issue_id, al.created_at AS started_at
      FROM activity_log al
      WHERE al.action = 'issue.statusChanged'
        AND al.payload ->> 'to' IN ('in_progress','approved')
        AND al.issue_id IN (SELECT issue_id FROM completions)
      ORDER BY al.issue_id, al.created_at ASC
    )
    SELECT c.project_id,
           avg(extract(epoch from (c.shipped_at - COALESCE(w.started_at, c.issue_created_at))) / 86400.0) AS avg_days
    FROM completions c
    LEFT JOIN work_start w ON w.issue_id = c.issue_id
    GROUP BY c.project_id
  `) as unknown as Promise<CycleRow[]>;

const readLiveRunRows = (projectIds: string[]) =>
  db
    .select({
      projectId: pipelineRuns.projectId,
      n: sql<number>`count(*)::int`,
    })
    .from(pipelineRuns)
    .where(
      and(
        inArray(pipelineRuns.projectId, projectIds),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
    )
    .groupBy(pipelineRuns.projectId);

const readRunnerRows = (projectIds: string[]) =>
  db
    .select({
      projectId: runners.projectId,
      n: sql<number>`count(*)::int`,
    })
    .from(runners)
    .where(and(inArray(runners.projectId, projectIds), eq(runners.status, 'online')))
    .groupBy(runners.projectId);

export type SpendRow = { project_id: string; spend: number };

const readSpendRows = (projectIds: string[]) =>
  db.execute(sql`
    SELECT project_id, COALESCE(SUM(cost_usd), 0)::float AS spend
    FROM pipeline_run_step_durations
    WHERE project_id IN (${idList(projectIds)})
      AND started_at >= now() - interval '24 hours'
    GROUP BY project_id
  `) as unknown as Promise<SpendRow[]>;

const readMemberRows = (projectIds: string[]) =>
  db
    .select({
      projectId: projectMembers.projectId,
      email: users.email,
      joinedAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(inArray(projectMembers.projectId, projectIds))
    .orderBy(projectMembers.projectId, projectMembers.createdAt);

const readIssueActivityRows = (projectIds: string[]) =>
  db
    .select({
      projectId: issues.projectId,
      lastAt: sql<string | null>`max(${issues.updatedAt})`,
    })
    .from(issues)
    .where(inArray(issues.projectId, projectIds))
    .groupBy(issues.projectId);

const readRunActivityRows = (projectIds: string[]) =>
  db
    .select({
      projectId: pipelineRuns.projectId,
      lastAt: sql<string | null>`max(${pipelineRuns.updatedAt})`,
    })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.projectId, projectIds))
    .groupBy(pipelineRuns.projectId);

/**
 * Run the ten reads concurrently under the module bound.
 *
 * The array order is load-bearing for the unit test's mock, which answers each
 * awaited query with the next row-set from a queue: the limiter starts parked
 * tasks in the order they asked, so the nth read still reads the nth row-set.
 */
export async function readHealthAggregates(projectIds: string[]) {
  const run = healthReadLimiter.run.bind(healthReadLimiter);
  const [
    statusRows,
    blockerRowsAll,
    throughputRows,
    cycleRows,
    liveRunRows,
    runnerRows,
    spendRows,
    memberRows,
    issueActivityRows,
    runActivityRows,
  ] = await Promise.all([
    run(() => readStatusRows(projectIds)),
    run(() => readBlockerRows(projectIds)),
    run(() => readThroughputRows(projectIds)),
    run(() => readCycleRows(projectIds)),
    run(() => readLiveRunRows(projectIds)),
    run(() => readRunnerRows(projectIds)),
    run(() => readSpendRows(projectIds)),
    run(() => readMemberRows(projectIds)),
    run(() => readIssueActivityRows(projectIds)),
    run(() => readRunActivityRows(projectIds)),
  ]);

  return {
    statusRows,
    blockerRowsAll,
    throughputRows,
    cycleRows,
    liveRunRows,
    runnerRows,
    spendRows,
    memberRows,
    issueActivityRows,
    runActivityRows,
  };
}
