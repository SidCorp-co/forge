/**
 * A project's health over a window (REQ-24 BC-1): per UTC day, the issues it shipped, the pipeline
 * steps that failed, the retries queued and the interventions an operator made, with the window's
 * totals and the window before it. Every figure is a count over a record Forge already keeps
 * (BC-2): the kernel's first-shipped read, `jobs`, and `job_events`; no counter is kept for it.
 */

import {
  HEALTH_FIGURES,
  type HealthDay,
  type HealthFigure,
  type ProjectHealth,
} from '@forge/contracts/project-health';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bucketBoundaries, bucketIso, utcDateTrunc } from '../lib/time-buckets.js';
import { firstShipped } from '../pipeline/index.js';

type Rows = Array<{ day: unknown; n: unknown }>;

/** One figure's per-day counts from `from` (inclusive) for the project. */
function countsSql(figure: HealthFigure, projectId: string, from: SQL): SQL {
  const day = (col: SQL) => utcDateTrunc('day', col);
  switch (figure) {
    case 'throughput':
      return sql`SELECT ${day(sql`f.shipped_at`)} AS day, count(*)::int AS n
        FROM (${firstShipped({ projectIds: [projectId], from })}) f GROUP BY 1`;
    case 'stepFailures':
      return sql`SELECT ${day(sql`finished_at`)} AS day, count(*)::int AS n FROM jobs
        WHERE project_id = ${projectId} AND status = 'failed' AND finished_at >= ${from} GROUP BY 1`;
    case 'retries':
      return sql`SELECT ${day(sql`queued_at`)} AS day, count(*)::int AS n FROM jobs
        WHERE project_id = ${projectId} AND retry_of IS NOT NULL AND queued_at >= ${from} GROUP BY 1`;
    case 'interventions':
      return sql`SELECT ${day(sql`e.ts`)} AS day, count(*)::int AS n
        FROM job_events e JOIN jobs j ON j.id = e.job_id
        WHERE j.project_id = ${projectId} AND e.kind = 'intervention' AND e.ts >= ${from} GROUP BY 1`;
  }
}

const zero = (): Record<HealthFigure, number> =>
  Object.fromEntries(HEALTH_FIGURES.map((f) => [f, 0])) as Record<HealthFigure, number>;

export async function projectHealth(
  projectId: string,
  days: number,
  now: Date = new Date(),
): Promise<ProjectHealth> {
  const buckets = bucketBoundaries('day', days, now);
  const first = buckets[0] ?? now.toISOString();
  const from = sql`${first}::timestamptz`;
  const before = sql`${first}::timestamptz - (${days}::int * interval '1 day')`;
  const byDay = new Map<string, HealthDay>(buckets.map((d) => [d, { day: d, ...zero() }]));
  const totals = zero();
  const previous = zero();
  for (const figure of HEALTH_FIGURES) {
    const rows = (await db.execute(countsSql(figure, projectId, before))) as unknown as Rows;
    for (const r of rows) {
      const day = bucketIso(r.day);
      const n = Number(r.n);
      const row = byDay.get(day);
      if (row) {
        row[figure] += n;
        totals[figure] += n;
      } else if (day < first) {
        previous[figure] += n;
      }
    }
  }
  return { projectId, days, series: [...byDay.values()], totals, previous };
}
