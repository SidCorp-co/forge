import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { claimCapableSql } from '../runners/device-cap.js';
import { runnerLive } from '../runners/liveness-sql.js';

/** The distinct non-empty `releaseRunnerLabel` values this job's project declares. */
const DECLARED_RELEASE_LABELS = sql`(
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
)`;

export const RELEASE_LABEL_FOR_JOB = sql`(
  SELECT CASE WHEN count(*) = 1 THEN min(label) END
  FROM ${DECLARED_RELEASE_LABELS} labels
  WHERE label IS NOT NULL
)`;

/**
 * How many different labels this job's project declares: 0 where nobody
 * declared one, 1 where they agree, more where they contradict each other.
 *
 * `RELEASE_LABEL_FOR_JOB` is NULL for the first and the last of those alike,
 * and they are opposite answers — no preference admits the pool, two
 * preferences admit nobody — so the count is read rather than the label
 * wherever the two have to be told apart (ISS-1275).
 */
export const RELEASE_LABEL_COUNT_FOR_JOB = sql`(
  SELECT count(*)
  FROM ${DECLARED_RELEASE_LABELS} labels
  WHERE label IS NOT NULL
)`;

/**
 * Whether some box on this job's project both carries the declared release
 * label and could take the job right now.
 *
 * Eligibility and not mere existence, because a labelled box that is offline
 * or below the claim floor cannot run the release: counting it would hold the
 * preference against boxes that can, which is the wedge ISS-1128 is about
 * wearing a longer wait instead of a 503.
 *
 * Needs `j` (the job row) in scope.
 */
export function eligibleBoxCarriesReleaseLabel(): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM runners preferred_r
    JOIN devices preferred_d ON preferred_d.id = preferred_r.device_id
    WHERE preferred_r.project_id = j.project_id
      AND COALESCE(preferred_r.labels, '[]'::jsonb) ? ${RELEASE_LABEL_FOR_JOB}
      AND ${runnerLive('preferred_r')}
      AND ${claimCapableSql('preferred_d')}
  )`;
}

/**
 * True for every job that is not a release, and for a release this box may
 * take: because the project declares no label at all, because this box carries
 * the one it declares, or because no box on the fleet that could take the
 * release carries it.
 *
 * ISS-1128 — the label RANKS the pool. A declaration of preference used to
 * remove every other box from it, so declaring which box a release *should*
 * prefer was the only way to say it and saying it stopped the project
 * deploying anywhere. A project whose boxes carry no matching label releases
 * on the pool it has.
 *
 * ISS-1275 finished that: nothing declared is the ordinary state of a project
 * that has expressed no preference, and it now admits the whole pool the way
 * every other job type already reaches it. The one contradiction left is two
 * live bindings naming different labels — `RELEASE_RUNNER_AMBIGUOUS`, which a
 * person resolves — and that still admits nobody.
 *
 * Needs `j` (the job row) in scope; `labels` defaults to the runner row `r`.
 */
export function runnerMayTakeJob(labels: SQL = sql`r.labels`): SQL {
  return sql`(
    j.type <> 'release_batch'
    OR ${RELEASE_LABEL_COUNT_FOR_JOB} = 0
    OR (
      ${RELEASE_LABEL_FOR_JOB} IS NOT NULL
      AND (
        COALESCE(${labels}, '[]'::jsonb) ? ${RELEASE_LABEL_FOR_JOB}
        OR NOT ${eligibleBoxCarriesReleaseLabel()}
      )
    )
  )`;
}

export type ReleaseLabelVerdict =
  | { allowed: true; label: string | null; preferenceMet: boolean }
  | { allowed: false; label: string | null; carried: string[] };

/**
 * The same question at claim time, for one job and one device.
 *
 * A job that does not exist is NOT a verdict — `prepareJobForMaster` owns
 * `not_found` and must stay the one that says it.
 *
 * `preferenceMet` is false where this box was admitted because nothing
 * eligible carries the label. The caller says so rather than letting a
 * declared preference go unhonoured in silence. A project that declared no
 * preference has none to leave unhonoured, so it reads true there.
 */
export async function releaseLabelVerdict(args: {
  jobId: string;
  deviceId: string;
}): Promise<ReleaseLabelVerdict> {
  const rows = (await db.execute(sql`
    SELECT j.type,
           ${RELEASE_LABEL_FOR_JOB} AS label,
           ${RELEASE_LABEL_COUNT_FOR_JOB} AS declared,
           COALESCE(r.labels, '[]'::jsonb) AS labels,
           ${eligibleBoxCarriesReleaseLabel()} AS preferred_available
    FROM jobs j
    LEFT JOIN runners r ON r.project_id = j.project_id AND r.device_id = ${args.deviceId}
    WHERE j.id = ${args.jobId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) return { allowed: true, label: null, preferenceMet: true };
  if (row.type !== 'release_batch') return { allowed: true, label: null, preferenceMet: true };

  const label = (row.label as string | null) ?? null;
  const carried = Array.isArray(row.labels) ? (row.labels as string[]) : [];
  // `count(*)` comes back as a bigint, which node-postgres hands over as a string.
  if (Number(row.declared) === 0) return { allowed: true, label: null, preferenceMet: true };
  if (label !== null && carried.includes(label))
    return { allowed: true, label, preferenceMet: true };
  if (label !== null && row.preferred_available !== true) {
    return { allowed: true, label, preferenceMet: false };
  }
  return { allowed: false, label, carried };
}
