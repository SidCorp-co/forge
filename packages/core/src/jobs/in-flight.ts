import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

const OCCUPYING_JOBS_FOR = (runnerFilter: ReturnType<typeof sql>) => sql`
  SELECT j.runner_id, COUNT(*)::int AS n
  FROM jobs j
  LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
  WHERE ${runnerFilter}
    AND j.status = 'dispatched'
    AND (pr.id IS NULL OR pr.status IN ('running', 'paused'))
  GROUP BY j.runner_id
`;

/** Occupying-job counts keyed by runner id; a runner with none is absent. */
export async function countInFlightByRunner(runnerIds: string[]): Promise<Map<string, number>> {
  if (runnerIds.length === 0) return new Map();

  const idList = sql.join(
    runnerIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<{ runner_id: string | null; n: number | string }>(
    OCCUPYING_JOBS_FOR(sql`j.runner_id IN (${idList})`),
  );

  return new Map(
    rows.filter((r) => r.runner_id !== null).map((r) => [r.runner_id as string, Number(r.n)]),
  );
}
