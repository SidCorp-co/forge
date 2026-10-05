import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';

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
