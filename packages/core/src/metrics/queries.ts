import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { windowCutoff } from './timeseries.js';

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
