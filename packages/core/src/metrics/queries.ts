import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { windowCutoff } from './timeseries.js';

type StepDurationAggRow = {
  project_id: string;
  project_slug: string | null;
  step: string;
  p50_s: number | string | null;
  p95_s: number | string | null;
  avg_s: number | string | null;
  total_cost: number | string | null;
  n: number | string | null;
};

type ProjectStepDurationRow = Omit<StepDurationAggRow, 'project_id' | 'project_slug'> & {
  breakdown_key?: string | null;
};

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

/**
 * The bounded rescue set: `retry_rescues_since`, called safely.
 */
export function retryRescuesSince(projectIds: readonly string[] | null, since: SQL): SQL {
  const scope =
    projectIds === null
      ? sql`NULL::uuid[]`
      : sql`ARRAY[${sql.join(
          projectIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`;
  return sql`retry_rescues_since(${scope}, ${since})`;
}

type RetryRescueRow = {
  failure_kind: string | null;
  failure_reason: string;
  rescues: number | string;
  last_rescued_at: string | Date;
};

export async function retryRescues(projectId: string, days: number): Promise<RetryRescueRow[]> {
  const result = await db.execute(sql`
    SELECT failure_kind, failure_reason, count(*)::int AS rescues,
           max(rescued_at) AS last_rescued_at
    FROM ${retryRescuesSince([projectId], windowCutoff(days))}
    GROUP BY failure_kind, failure_reason
    ORDER BY rescues DESC, last_rescued_at DESC
  `);
  return result as unknown as RetryRescueRow[];
}

type SessionFailureAggRow = {
  status: string | null;
  failure_reason: string | null;
  sessions: number | string;
  last_at: string | Date | null;
};

export async function sessionFailures(
  projectId: string,
  days: number,
): Promise<SessionFailureAggRow[]> {
  const result = await db.execute(sql`
    SELECT status, failure_reason, count(*)::int AS sessions, max(updated_at) AS last_at
    FROM agent_sessions
    WHERE project_id = ${projectId}
      AND updated_at >= now() - (${days}::int * interval '1 day')
      AND (status IN ('failed', 'cancelled_stale') OR failure_reason IS NOT NULL)
    GROUP BY status, failure_reason
  `);
  return result as unknown as SessionFailureAggRow[];
}

type ResumeDropRow = { drop_reason: string | null; sessions: number | string };

export async function resumeDropsForProject(
  projectId: string,
  days: number,
): Promise<ResumeDropRow[]> {
  const result = await db.execute(sql`
    SELECT metadata->'resume'->>'dropReason' AS drop_reason, count(*)::int AS sessions
    FROM agent_sessions
    WHERE project_id = ${projectId}
      AND created_at >= now() - (${days}::int * interval '1 day')
      AND metadata->'resume'->>'priorClaudeSessionId' IS NOT NULL
    GROUP BY 1
  `);
  return result as unknown as ResumeDropRow[];
}
