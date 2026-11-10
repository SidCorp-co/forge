/**
 * How a project's runs move (REQ-43 r3 BC-16), the Agents band's one chart: runs started and runs
 * finished on each of the last `RUN_FLOW_DAYS` days in the reader's zone. It counts the runs the run
 * list counts (`RUN_SCOPE_SQL`: no chat, no master's own run). The instants are read raw and the day is
 * counted here by `day-keys.ts`, the rule the home and every band count a day by.
 */

import { dayKeyIn, daysEnding } from '@forge/contracts/day-keys';
import { RUN_FLOW_DAYS, type RunFlow } from '@forge/contracts/run-flow';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { RUN_SCOPE_SQL } from './facts.js';

const DAY_MS = 86_400_000;

type Instants = { startedAt: Date | string | null; finishedAt: Date | string | null };

/** Folds each run's start and finish into the days ending `today`; an instant outside them is not drawn. */
export function runFlowOf(
  runs: readonly Instants[],
  dayOf: (at: Date | string) => string,
  today: string,
): RunFlow['days'] {
  const days = new Map(
    daysEnding(today, RUN_FLOW_DAYS).map((day) => [day, { day, started: 0, finished: 0 }]),
  );
  for (const r of runs) {
    const s = r.startedAt ? days.get(dayOf(r.startedAt)) : undefined;
    if (s) s.started += 1;
    const f = r.finishedAt ? days.get(dayOf(r.finishedAt)) : undefined;
    if (f) f.finished += 1;
  }
  return [...days.values()];
}

export async function readRunFlow(
  projectId: string,
  tz: string,
  now: Date = new Date(),
): Promise<RunFlow> {
  // a day wider than the window on its far side, so no zone's first day is cut; the fold drops the rest
  const since = new Date(now.getTime() - (RUN_FLOW_DAYS + 1) * DAY_MS).toISOString();
  const runs = await db.execute(sql`
    SELECT r.started_at AS "startedAt", r.finished_at AS "finishedAt" FROM pipeline_runs r
     WHERE r.project_id = ${projectId} AND ${RUN_SCOPE_SQL}
       AND (r.started_at >= ${since}::timestamptz OR r.finished_at >= ${since}::timestamptz)`);
  const dayOf = dayKeyIn(tz);
  return { projectId, tz, days: runFlowOf(rowsOf<Instants>(runs), dayOf, dayOf(now)) };
}
