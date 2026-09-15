import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns, projectMembers, projects, runners, users } from '../db/schema.js';
import { activityLog } from '../db/schema-activity.js';
import { createLimiter } from '../lib/bounded-concurrency.js';

/**
 * The ten independent per-project reads behind `GET /api/projects/health`, and
 * the bound they run under. They were awaited one after another until ISS-1018;
 * the figures are unchanged and the latency is now three waves rather than ten
 * round trips.
 */

// cm:guard the limiter is MODULE-scoped on purpose, so it bounds health traffic as a whole rather than one request at a time: `db/client.ts` opens the pool at `max: 10`, and a per-request bound of four still lets three overlapping requests ask for twelve and starve everything else (ISS-1018).
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

// cm:guard build a parenthesised parameter list and use `IN (...)`: embedding a JS array directly in a drizzle template expands it as a record tuple ($1, $2, ...), so `= ANY(...)` / `ANY(...::uuid[])` is a malformed array literal and 500s the whole endpoint — two prior live FAILs.
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

// cm:guard the ORDER BY (project, updatedAt DESC) is required, not cosmetic: the caller caps this list per project, so without it one noisy project's blockers starve every other project's out of the response.
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

// cm:guard reads BOTH `released` and `awaiting_release` because `activity_log` is HISTORY: 4,488 rows were written while the rung was called `released` (renamed 2026-09-10, migration 0228) and no migration rewrites them — a payload records what the status was called when it happened. Drop either spelling and the figure silently loses one side of that date.
// cm:guard the 7-day cutoff is computed in SQL (`now() - interval '7 days'`) and never bound as a JS Date: postgres-js refuses to serialize a Date through a parameterized query and throws `ERR_INVALID_ARG_TYPE` from Buffer.byteLength at Bind time (ISS-267).
const readThroughputRows = (projectIds: string[]) =>
  db
    .select({
      projectId: issues.projectId,
      n: sql<number>`count(*)::int`,
    })
    .from(activityLog)
    .innerJoin(issues, eq(issues.id, activityLog.issueId))
    .where(
      and(
        inArray(issues.projectId, projectIds),
        eq(activityLog.action, 'issue.statusChanged'),
        sql`${activityLog.payload} ->> 'to' IN ('closed','released','awaiting_release')`,
        sql`${activityLog.createdAt} >= now() - interval '7 days'`,
      ),
    )
    .groupBy(issues.projectId);

export type CycleRow = { project_id: string; avg_days: number | null };

// cm:guard `work_start` is the FIRST transition into `in_progress`/`approved`, never `issues.createdAt` — reading creation time measures LEAD time and overstates cycle time by however long the issue sat in the backlog (ISS-380). The COALESCE onto `createdAt` is only for issues that predate those transitions.
// cm:guard the work-start relation is bounded by ISSUE and never by TIME — the seven days are the COMPLETION window, and restricting this side to them measures an issue started earlier from its creation date instead, silently and in the same direction every time (ISS-1018).
const readCycleRows = (projectIds: string[]) =>
  db.execute(sql`
    WITH completions AS (
      SELECT al.issue_id, al.created_at, i.project_id, i.created_at AS issue_created_at
      FROM activity_log al
      JOIN issues i ON i.id = al.issue_id
      WHERE i.project_id IN (${idList(projectIds)})
        AND al.action = 'issue.statusChanged'
        AND al.payload ->> 'to' IN ('closed','released','awaiting_release')
        AND al.created_at >= now() - interval '7 days'
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
           avg(extract(epoch from (c.created_at - COALESCE(w.started_at, c.issue_created_at))) / 86400.0) AS avg_days
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

// cm:why the pipeline_run_step_durations view is the same source the per-project cost-summary route reads, so the two figures cannot disagree.
const readSpendRows = (projectIds: string[]) =>
  db.execute(sql`
    SELECT project_id, COALESCE(SUM(cost_usd), 0)::float AS spend
    FROM pipeline_run_step_durations
    WHERE project_id IN (${idList(projectIds)})
      AND started_at >= now() - interval '24 hours'
    GROUP BY project_id
  `) as unknown as Promise<SpendRow[]>;

// cm:guard ordered by (projectId, createdAt) because the caller caps the avatar list per project: unordered, which five members get an avatar changes between requests.
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
