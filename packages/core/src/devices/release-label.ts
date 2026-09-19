import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export const RELEASE_LABEL_FOR_JOB = sql`(
  SELECT CASE WHEN count(*) = 1 THEN min(label) END FROM (
    SELECT DISTINCT NULLIF(
      CASE WHEN b.config ? 'releaseRunnerLabel'
           THEN b.config ->> 'releaseRunnerLabel'
           ELSE c.config ->> 'releaseRunnerLabel' END, '') AS label
    FROM integration_bindings b
    JOIN integration_connections c ON c.id = b.connection_id
    WHERE b.project_id = j.project_id
      AND b.role = 'deploy'
      AND 'live' = ANY(b.stages)
      AND b.active
      AND c.active
  ) labels
  WHERE label IS NOT NULL
)`;

/**
 * True for every job that is not a release, and for a release whose project's
 * label this runner carries.
 *
 * Needs `j` (the job row) and `r` (the runner row) in scope.
 */
export const RUNNER_MAY_TAKE_JOB = sql`(
  j.type <> 'release_batch'
  OR r.labels ? ${RELEASE_LABEL_FOR_JOB}
)`;

export type ReleaseLabelVerdict =
  | { allowed: true }
  | { allowed: false; label: string | null; carried: string[] };

/**
 * The same question at claim time, for one job and one device.
 *
 * A job that does not exist is NOT a verdict — `prepareJobForMaster` owns
 * `not_found` and must stay the one that says it.
 */
export async function releaseLabelVerdict(args: {
  jobId: string;
  deviceId: string;
}): Promise<ReleaseLabelVerdict> {
  const rows = (await db.execute(sql`
    SELECT j.type,
           ${RELEASE_LABEL_FOR_JOB} AS label,
           COALESCE(r.labels, '[]'::jsonb) AS labels
    FROM jobs j
    LEFT JOIN runners r ON r.project_id = j.project_id AND r.device_id = ${args.deviceId}
    WHERE j.id = ${args.jobId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) return { allowed: true };
  if (row.type !== 'release_batch') return { allowed: true };

  const label = (row.label as string | null) ?? null;
  const carried = Array.isArray(row.labels) ? (row.labels as string[]) : [];
  if (label !== null && carried.includes(label)) return { allowed: true };
  return { allowed: false, label, carried };
}
