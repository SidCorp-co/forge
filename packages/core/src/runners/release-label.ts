import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { claimCapableSql } from './device-cap.js';
import { runnerLive } from './liveness-sql.js';

// cm:edge contract -> packages/core/src/project-config/release-path.ts:productionOf — the one
// production environment's deploy binding, read off the stored project document.
/** The non-empty `releaseRunnerLabel` the production deploy binding of this job's project declares. */
const RELEASE_LABEL_FOR_JOB = sql`(
  SELECT NULLIF(
    CASE WHEN b.config ? 'releaseRunnerLabel'
         THEN b.config ->> 'releaseRunnerLabel'
         ELSE c.config ->> 'releaseRunnerLabel' END, '')
  FROM project_config_documents d
  CROSS JOIN LATERAL jsonb_each(d.document -> 'environments') env
  JOIN integration_bindings b ON b.id::text = env.value #>> '{deployment,binding}'
  JOIN integration_connections c ON c.id = b.connection_id
  WHERE d.project_id = j.project_id
    AND env.value ->> 'tier' = 'production'
    AND b.project_id = j.project_id
    AND b.role = 'deploy'
    AND b.active
    AND c.active
  LIMIT 1
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
function eligibleBoxCarriesReleaseLabel(): SQL {
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
 * every other job type already reaches it.
 *
 * Needs `j` (the job row) in scope; `labels` defaults to the runner row `r`.
 */
export function runnerMayTakeJob(labels: SQL = sql`r.labels`): SQL {
  return sql`(
    j.type <> 'release_batch'
    OR ${RELEASE_LABEL_FOR_JOB} IS NULL
    OR COALESCE(${labels}, '[]'::jsonb) ? ${RELEASE_LABEL_FOR_JOB}
    OR NOT ${eligibleBoxCarriesReleaseLabel()}
  )`;
}

type ReleaseLabelVerdict =
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
  if (label === null) return { allowed: true, label: null, preferenceMet: true };
  if (carried.includes(label)) return { allowed: true, label, preferenceMet: true };
  if (row.preferred_available !== true) return { allowed: true, label, preferenceMet: false };
  return { allowed: false, label, carried };
}
