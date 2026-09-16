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
  if (!row) return { admitted: true };
  if (row.runner_id == null) return { admitted: false, reason: 'runner_unbound' };
  if (row.device_disabled_at != null) return { admitted: false, reason: 'device_disabled' };
  if (NON_ADMITTED_RUNNER_STATUSES.includes(row.status as never)) {
    return { admitted: false, reason: 'runner_withdrawn' };
  }
  return { admitted: true };
}
