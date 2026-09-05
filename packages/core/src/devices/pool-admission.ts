// Whether a runner is ALLOWED to take work, which is not whether it is alive.
//
// A master reading the pool is alive by definition — the poll is the proof — so
// admission asks the other question: has an operator said this box may run jobs?
// `runners.status` has carried `draining` and `disabled` since the table existed
// and nothing on the claim path read either, so `forge_runners drain` and the
// status PATCH both changed a column no code consulted.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export const NON_ADMITTED_RUNNER_STATUSES = ['disabled', 'draining'] as const;

// cm:guard exclude the statuses that WITHDRAW a box, never require `online` — the heartbeat mirror is what writes `online`, so requiring it hands a live runner an empty pool whenever that mirror lags, with nothing anywhere saying why. Admission is a permission question; liveness is already answered by the master being here to ask.
// cm:edge lockstep -> packages/core/src/devices/claim.ts — `claimJobForMaster` calls `runnerAdmission` with this same predicate. Offer work here that the claim refuses and every master burns a round trip on a job it can never take; admit here what the claim allows and the pool hides work a box was entitled to.
// cm:edge lockstep -> packages/core/src/devices/heartbeat-runner-mirror.ts — that UPDATE must preserve every status named here. It preserved only `disabled`, so a drained runner came back `online` on the next beat (~30s) and this exclusion would have quietly stopped applying.
export const ADMITTED_RUNNER = sql`
  r.status NOT IN ('disabled', 'draining')
  AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL)
`;

export type RunnerAdmission =
  | { admitted: true }
  | { admitted: false; reason: 'runner_withdrawn' | 'device_disabled' | 'runner_unbound' };

/**
 * Whether this device may take work on the project that owns `jobId`.
 *
 * Answers by name so the refusal reaches the master's transcript: a box that
 * has gone quiet is an operator's question, and "no reason given" is the state
 * this refuses to produce.
 */
// cm:guard scope the binding by the JOB's project, never by the device alone — one box can be bound to several projects and an operator drains them one at a time, so a device-wide answer would withdraw a runner from projects nobody touched.
export async function runnerAdmission(args: {
  jobId: string;
  deviceId: string;
}): Promise<RunnerAdmission> {
  const rows = (await db.execute(sql`
    SELECT r.id AS runner_id, r.status,
           (SELECT d.disabled_at FROM devices d WHERE d.id = r.device_id) AS device_disabled_at
    FROM jobs j
    LEFT JOIN runners r ON r.project_id = j.project_id AND r.device_id = ${args.deviceId}
    WHERE j.id = ${args.jobId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0];
  // cm:guard a job that does not exist is NOT an admission verdict — the LEFT JOIN is what keeps the two apart, and answering here would have the claim tell a master its box is unbound when the job is simply gone. `claimJobForMaster` owns `not_found` and must stay the one that says it.
  if (!row) return { admitted: true };
  if (row.runner_id == null) return { admitted: false, reason: 'runner_unbound' };
  if (row.device_disabled_at != null) return { admitted: false, reason: 'device_disabled' };
  if (NON_ADMITTED_RUNNER_STATUSES.includes(row.status as never)) {
    return { admitted: false, reason: 'runner_withdrawn' };
  }
  return { admitted: true };
}
