// The steward's demand for subagent slots on one box (ISS-1255). A steward runner job (a triage, an
// output's follow-through after its release) is a run on its project's box like any other, so it is
// counted in `devices/run-slots-read.ts:readBoxSlots` beside the project's run sessions and ready
// issues, and `devices/run-slots.ts:slotsFor` alone decides whether it may start. Nothing here
// decides a count: the steward only says what it holds and what it waits on.

import { LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { RUNNER_ACTS } from './runs-store.js';

export interface StewardSlotDemand {
  /** Its steward jobs live for a live run: out with this box, or queued for one of its boxes. */
  live: number;
  /** Its live runs owing a runner act that no job has been started for yet, a run tried again for a slot included. */
  waiting: number;
  /** Whether one of those waiting is a release follow-through: the judge a shipped issue is owed. */
  urgent: boolean;
}

type Executor = Pick<Tx, 'execute'>;

/** What each project bound to `deviceId` holds and waits on of its steward's runner jobs. */
export async function stewardSlotDemand(
  executor: Executor,
  deviceId: string,
): Promise<Map<string, StewardSlotDemand>> {
  const runner = sql.raw(`ARRAY[${RUNNER_ACTS.map((a) => `'${a}'`).join(', ')}]::text[]`);
  const live = sql.raw(LIVE_JOB_STATUSES.map((s) => `'${s}'`).join(', '));
  const rows = rowsOf<{ project_id: string; live: number; waiting: number; urgent: boolean }>(
    await executor.execute(sql`
      WITH bound AS (SELECT DISTINCT project_id FROM runners WHERE device_id = ${deviceId})
      SELECT b.project_id::text AS project_id,
             (SELECT count(*) FROM jobs j
                JOIN steward_runs s ON s.id::text = j.payload ->> 'stewardRunId'
               WHERE j.project_id = b.project_id AND j.type = 'steward'
                 AND j.status IN (${live}) AND s.state IN ('queued', 'running')
                 AND (j.device_id IS NULL OR j.device_id = ${deviceId}))::int AS live,
             count(r.id)::int AS waiting,
             coalesce(bool_or(r.acts_to_run && ARRAY['release_followthrough']::text[]), false) AS urgent
        FROM bound b
        LEFT JOIN steward_runs r
          ON r.project_id = b.project_id AND r.state IN ('queued', 'running')
         AND r.job_id IS NULL AND r.acts_to_run && ${runner}
       GROUP BY b.project_id`),
  );
  const out = new Map<string, StewardSlotDemand>();
  for (const r of rows) {
    if (r.live > 0 || r.waiting > 0) {
      out.set(r.project_id, { live: r.live, waiting: r.waiting, urgent: r.urgent });
    }
  }
  return out;
}
