import { and, count, desc, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type JobType, type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import { listItemsFromRows } from './runs-rollup.js';
import type { PipelineRunListItem } from './runs-rollup-types.js';

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

type StepDurationStatRow = {
  step: string;
  p50_s: number | string | null;
  p95_s: number | string | null;
  avg_s: number | string | null;
  total_cost: number | string | null;
  n: number | string | null;
};

type ProjectStepDurationRow = StepDurationStatRow & { breakdown_key?: string | null };

/** A project's per-step p50/p95/average and cost over the last `days`, optionally per device or model. */
export async function stepDurationsForProject(
  projectId: string,
  days: number,
  step?: string,
  breakdown?: 'device' | 'model',
): Promise<ProjectStepDurationRow[]> {
  const stepFilter = step ? sql`AND step = ${step}` : sql``;
  const breakdownCol =
    breakdown === 'device' ? sql`device_id` : breakdown === 'model' ? sql`model_used` : null;
  const breakdownSelect = breakdownCol ? sql`${breakdownCol} AS breakdown_key,` : sql``;
  const breakdownGroup = breakdownCol ? sql`, ${breakdownCol}` : sql``;
  const result = await db.execute(sql`
    SELECT step,
           ${breakdownSelect}
           percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_seconds) AS p50_s,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_seconds) AS p95_s,
           avg(duration_seconds)::float AS avg_s,
           sum(cost_usd)::float AS total_cost,
           count(duration_seconds)::int AS n
    FROM pipeline_run_step_durations
    WHERE project_id = ${projectId}
      AND started_at >= now() - (${days}::int * interval '1 day')
      ${stepFilter}
    GROUP BY step${breakdownGroup}
    ORDER BY step
  `);
  return result as unknown as ProjectStepDurationRow[];
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
