import { and, count, desc, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type JobType, type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import { utcDayText } from '../lib/time-buckets.js';
import { retryRescuesSince } from '../metrics/queries.js';
import { cycleTimeTransitionsSql } from './cycle-time-sql.js';
import { listItemsFromRows, type PipelineRunListItem } from './runs-rollup.js';

/** Average hours each status held before its transition out, over the last `days`. */
export async function readCycleTime(projectIds: string[], days: number) {
  const rows = await db.execute(sql`
    WITH transitions AS (${cycleTimeTransitionsSql(projectIds, days)}
    )
    SELECT
      prev_to AS status,
      AVG(EXTRACT(EPOCH FROM (created_at - prev_created_at)) / 3600.0)::float AS avg_hours,
      count(*)::int AS n
    FROM transitions
    WHERE prev_created_at IS NOT NULL AND prev_to IS NOT NULL
    GROUP BY prev_to
    ORDER BY n DESC
  `);
  return (rows as unknown as Array<{ status: string; avg_hours: number; n: number }>).map((r) => ({
    status: r.status,
    avgHours: Number(r.avg_hours),
    n: Number(r.n),
  }));
}

/** The last `days` of finished step durations, newest first, at most 1000. */
export async function readStepDurations(
  projectIds: string[],
  days: number,
  step: JobType | undefined,
) {
  const stepFilter = step ? sql`AND step = ${step}` : sql``;
  const rows = await db.execute(sql`
    SELECT run_id, issue_id, project_id, step, started_at, finished_at,
           duration_seconds, cost_usd, device_id, model_used
    FROM pipeline_run_step_durations
    WHERE project_id IN ${projectIds}
      AND started_at >= now() - (${days}::int * interval '1 day')
      AND duration_seconds IS NOT NULL
      ${stepFilter}
    ORDER BY started_at DESC
    LIMIT 1000
  `);
  return (
    rows as unknown as Array<{
      run_id: string;
      issue_id: string | null;
      project_id: string;
      step: string;
      started_at: string;
      finished_at: string;
      duration_seconds: number;
      cost_usd: number;
      device_id: string | null;
      model_used: string | null;
    }>
  ).map((r) => ({
    runId: r.run_id,
    issueId: r.issue_id,
    projectId: r.project_id,
    step: r.step,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationSeconds: Number(r.duration_seconds),
    costUsd: Number(r.cost_usd),
    deviceId: r.device_id,
    modelUsed: r.model_used,
  }));
}

/** Retry failures a later attempt rescued in the last `days`, grouped by the original reason. */
export async function readRetryRescues(projectIds: string[], days: number) {
  const rows = await db.execute(sql`
    SELECT project_id, failure_kind, failure_reason, count(*)::int AS rescues,
           max(rescued_at) AS last_rescued_at
    FROM ${retryRescuesSince(projectIds, sql`now() - (${days}::int * interval '1 day')`)}
    GROUP BY project_id, failure_kind, failure_reason
    ORDER BY rescues DESC, last_rescued_at DESC
    LIMIT 2000
  `);
  const reasons = (
    rows as unknown as Array<{
      project_id: string;
      failure_kind: string | null;
      failure_reason: string;
      rescues: number | string;
      last_rescued_at: string | Date;
    }>
  ).map((row) => ({
    projectId: row.project_id,
    failureKind: row.failure_kind,
    failureReason: row.failure_reason,
    rescues: Number(row.rescues),
    lastRescuedAt:
      row.last_rescued_at instanceof Date
        ? row.last_rescued_at.toISOString()
        : String(row.last_rescued_at),
  }));
  return { total: reasons.reduce((total, row) => total + row.rescues, 0), reasons };
}

/** A project's cost over the last `days`: the total, a per-step rollup and the top 10 issues. */
export async function readCostSummary(projectId: string, days: number) {
  const totalRows = await db.execute(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::float AS total
    FROM pipeline_run_step_durations
    WHERE project_id = ${projectId}
      AND started_at >= now() - (${days}::int * interval '1 day')
  `);
  const total = Number((totalRows as unknown as Array<{ total: number }>)[0]?.total ?? 0);

  const byStateRows = await db.execute(sql`
    SELECT step, SUM(cost_usd)::float AS total, COUNT(*)::int AS runs
    FROM pipeline_run_step_durations
    WHERE project_id = ${projectId}
      AND started_at >= now() - (${days}::int * interval '1 day')
    GROUP BY step
    ORDER BY total DESC
  `);

  const byIssueRows = await db.execute(sql`
    SELECT issue_id, SUM(cost_usd)::float AS total
    FROM pipeline_run_step_durations
    WHERE project_id = ${projectId}
      AND started_at >= now() - (${days}::int * interval '1 day')
      AND issue_id IS NOT NULL
    GROUP BY issue_id
    ORDER BY total DESC
    LIMIT 10
  `);

  const byState = (
    byStateRows as unknown as Array<{ step: string; total: number; runs: number }>
  ).map((r) => {
    const totalCost = Number(r.total);
    const runs = Number(r.runs);
    return { state: r.step, total: totalCost, runs, avgPerRun: runs > 0 ? totalCost / runs : 0 };
  });

  const byIssue = (byIssueRows as unknown as Array<{ issue_id: string; total: number }>).map(
    (r) => ({ issueId: r.issue_id, total: Number(r.total) }),
  );

  return { total, byState, byIssue };
}

/** A project's daily cost over the last `days`, optionally for one step. */
export async function readCostTrend(projectId: string, days: number, step: JobType | undefined) {
  const stepFilter = step ? sql`AND step = ${step}` : sql``;
  const dailyRows = await db.execute(sql`
    SELECT ${utcDayText(sql`started_at`)} AS date,
           SUM(cost_usd)::float AS cost,
           COUNT(*)::int AS runs
    FROM pipeline_run_step_durations
    WHERE project_id = ${projectId}
      AND started_at >= now() - (${days}::int * interval '1 day')
      ${stepFilter}
    GROUP BY 1
    ORDER BY 1 ASC
  `);
  const daily = (dailyRows as unknown as Array<{ date: string; cost: number; runs: number }>).map(
    (r) => ({ date: r.date, cost: Number(r.cost), runs: Number(r.runs) }),
  );
  return { daily };
}

/** The runs at or above the window's p95 cost, at most 100, and that threshold. */
export async function readCostOutliers(projectId: string, days: number) {
  const rows = await db.execute(sql`
    WITH win AS (
      SELECT v.run_id, v.issue_id, v.step, v.cost_usd,
             j.id AS job_id, j.agent_session_id
      FROM pipeline_run_step_durations v
      JOIN jobs j ON j.pipeline_run_id = v.run_id AND j.type = v.step
      WHERE v.project_id = ${projectId}
        AND v.started_at >= now() - (${days}::int * interval '1 day')
    ),
    thresh AS (
      SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY cost_usd)::float AS p95
      FROM win
    )
    SELECT win.job_id, win.step AS state, win.cost_usd AS cost, win.issue_id,
           COALESCE(length(i.description), 0) AS description_len,
           COALESCE(jsonb_array_length(s.messages), 0) AS session_depth,
           (SELECT p95 FROM thresh) AS threshold
    FROM win
    LEFT JOIN issues i ON i.id = win.issue_id
    LEFT JOIN agent_sessions s ON s.id = win.agent_session_id
    WHERE win.cost_usd >= (SELECT p95 FROM thresh)
      AND (SELECT p95 FROM thresh) > 0
    ORDER BY win.cost_usd DESC
    LIMIT 100
  `);

  const typed = rows as unknown as Array<{
    job_id: string;
    state: string;
    cost: number;
    issue_id: string | null;
    description_len: number;
    session_depth: number;
    threshold: number;
  }>;

  const threshold = typed.length > 0 ? Number(typed[0]?.threshold ?? 0) : 0;
  const runs = typed.map((r) => ({
    jobId: r.job_id,
    state: r.state,
    cost: Number(r.cost),
    issueId: r.issue_id,
    dimensions: {
      descriptionLen: Number(r.description_len),
      sessionDepth: Number(r.session_depth),
    },
  }));
  return { threshold, runs };
}

/** The project a pipeline run belongs to, or null when no such run exists. */
export async function pipelineRunProjectId(runId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: pipelineRuns.projectId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return row?.projectId ?? null;
}

/** One page of a project's pipeline runs, newest first, as list items, and the filter's total. */
export async function listProjectPipelineRuns(
  projectId: string,
  filter: {
    status?: PipelineRunStatus | undefined;
    issueId?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ items: PipelineRunListItem[]; total: number }> {
  const conds: SQL[] = [eq(pipelineRuns.projectId, projectId)];
  if (filter.status) conds.push(eq(pipelineRuns.status, filter.status));
  if (filter.issueId) conds.push(eq(pipelineRuns.issueId, filter.issueId));
  const where = conds.length === 1 ? conds[0] : and(...conds);

  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(pipelineRuns).where(where);
  const rows = await db
    .select()
    .from(pipelineRuns)
    .where(where)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(filter.limit)
    .offset(filter.offset);

  return { items: await listItemsFromRows(rows), total: Number(n) };
}
