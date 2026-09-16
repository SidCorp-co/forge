/**
 * Which box may take a `release_batch` job.
 *
 * The release pool existed on paper and nowhere on the claim path. The label
 * was resolved once, inside `createReleaseBatch`, to answer "is anyone in the
 * pool alive" — and then the job went into the queue like any other, `readPool`
 * offered it to whoever asked and `devices/claim.ts` contained no occurrence of
 * the word `label`. So the box that holds the production credential and the box
 * that ran the release were the same box only by luck of who polled first.
 *
 * One predicate, asked at both moments, because they are the same question: the
 * pool must not OFFER work the claim would refuse, and the claim must not take
 * the pool's word for a page of rows it has been holding across a round trip.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * The project's declared release label, as SQL, for a query that has `j` in
 * scope as the job row.
 */
// cm:edge lockstep -> packages/core/src/release-batch/channel.ts — this must read the SAME bindings and the SAME key as `releaseRunnerLabelOf`, which takes every ACTIVE deploy binding carrying the `live` stage whose connection is also active and overlays the connection's config with the binding's. The `?` test rather than COALESCE is that overlay exactly: a binding that sets the key to null or empty hides the connection's value, which `{...connection, ...binding}` does and a COALESCE does not. Two readings of "which box releases" is how a job gets offered to a box the release itself would have refused.
// cm:guard RAW SQL, so `role`/`stages` here is type-checked by NOTHING — this line said `b.environment = 'prod'` until ISS-1046 renamed the column out from under it, and a stale predicate here fails by matching no row, which presents as "no runner in the pool" rather than as a schema break. `scripts/check-retired-model.mjs` is what catches it now.
// cm:why `NULLIF(…, '')` is `releaseRunnerLabelOf`'s own `length > 0` test — an empty label is not a label, and matching on it would put every unlabelled runner in the pool.
// cm:why the NULLs are dropped BEFORE the `LIMIT 1` and there is no `ORDER BY created_at`: `releaseRunnerLabelOf` filters nulls out and then refuses two surviving values (`RELEASE_RUNNER_AMBIGUOUS`), so a live set is either all-unlabelled or carries exactly one label beside any number of unlabelled bindings. Ordering by age instead would let an older unlabelled binding hide a younger one's label — a silent pick the other reader does not make, and the shape `bindings[0]` had.
export const RELEASE_LABEL_FOR_JOB = sql`(
  SELECT label FROM (
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
  LIMIT 1
)`;

/**
 * True for every job that is not a release, and for a release whose project's
 * label this runner carries.
 *
 * Needs `j` (the job row) and `r` (the runner row) in scope.
 */
// cm:guard a `release_batch` job on a project that declares NO label matches nobody, and that is the refusal rather than an oversight. `createReleaseBatch` throws `RELEASE_RUNNER_UNDECLARED` before such a job can be made, so the only way to hold one is to have unset the label after the cut — and widening to the fleet there is exactly the silent substitution this module exists to remove: the release would land on a box with no production credential, with the merge already pushed.
// cm:why `r.labels ? <label>` is jsonb element-membership over an ARRAY, not key lookup, same as `resolveReleaseDeviceIds`.
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
// cm:edge lockstep -> packages/core/src/devices/pool.ts — `RUNNER_MAY_TAKE_JOB` and this function are one rule read twice. Looser here offers work the pool hid; looser there burns a master's round trip on a job it can never take, and neither failure says a word.
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
