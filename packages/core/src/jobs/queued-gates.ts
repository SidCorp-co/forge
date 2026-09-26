import { eq, type SQL, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { jobs } from '../db/schema.js';
import { runnerMayTakeJob } from '../devices/release-label.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { RUNNER_CAPABILITIES } from '../pipeline/registry.js';
import { claimCapableSql } from '../runners/device-cap.js';
import {
  deviceNotDisabled,
  runnerFresh,
  runnerUnlimited,
  runnerWorkspaceReady,
} from '../runners/liveness-sql.js';
import { countInFlightForOneRunner } from './in-flight.js';

export type GateSkipReason =
  | 'not_found'
  | 'not_queued'
  | 'pipeline_run_not_running'
  | 'retry_cooldown'
  | 'issue_busy'
  | 'runner_too_old'
  | 'runner_stale'
  | 'release_label_missing';

/**
 * What {@link assertDispatchable} answers. `ok: false` carries the first
 * reason the CASE matched — the arms run in precedence order, so it is the
 * most specific one.
 */
export type DispatchBarrier = { ok: true } | { ok: false; reason: GateSkipReason; hint?: string };

type DispatchGateExecutor = Pick<Db, 'select' | 'execute'>;

/**
 * Runner ↔ job-type capability gate. Sourced from the pipeline registry
 * (single SSOT — see `pipeline/registry.ts`). A master reads it to know which
 * of its boxes could run a job type at all.
 *
 * `pm` and `custom` are intentionally excluded from RUNNER_CAPABILITIES —
 * PM flows through a dedicated queue and bypasses the gate; `custom` is
 * operator-defined and has no canonical runner mapping.
 */
export function runnerSupportsJobType(runnerType: RunnerType, jobType: JobType): boolean {
  const caps = RUNNER_CAPABILITIES[runnerType];
  return caps ? caps.includes(jobType) : false;
}

export async function countInFlightForRunner(runnerId: string): Promise<number> {
  return countInFlightForOneRunner(runnerId);
}

export interface BarrierFragments {
  /** Shared CTE chunk: `fresh_capable_runners`.
   *  Caller prefixes with `WITH ${ctes}` (and may comma-append more CTEs). */
  ctes: SQL;
  /** Gate predicates as failing-form SQL fragments. The picker negates each
   *  in its WHERE clause (`AND NOT (${predicate})`); the asserter wraps each
   *  in a CASE WHEN to report a granular skip reason. */
  predicates: {
    issueBusySession: SQL;
    issueBusyJob: SQL;
  };
}

export function buildBarrierFragments(args: {
  projectIds: readonly string[];
  livenessSeconds: number;
}): BarrierFragments {
  const { projectIds, livenessSeconds } = args;
  const projectScope =
    projectIds.length === 0
      ? sql`false`
      : sql`r.project_id IN (${sql.join(
          projectIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;

  const ctes = sql`    fresh_capable_runners AS (
      SELECT r.id,
             -- boxes. A reader that selects from this CTE without correlating gets every project's
             -- runners, which reads as "a usable box exists" for a project that has none.
             r.project_id,
             r.labels,
             ${claimCapableSql('d')} AS claim_capable
      FROM runners r
      JOIN devices d ON d.id = r.device_id
      WHERE ${projectScope}
        AND ${runnerFresh('r', livenessSeconds)}
        AND ${runnerUnlimited('r')}
        AND ${runnerWorkspaceReady('r')}
        AND ${deviceNotDisabled('r')}
    )`;

  const predicates = {
    issueBusySession: sql`EXISTS (
      SELECT 1 FROM agent_sessions s
      WHERE s.status IN ('queued','running')
        AND (s.metadata->>'issueId') = j.issue_id::text
        AND (j.agent_session_id IS NULL OR s.id <> j.agent_session_id)
    )`,
    issueBusyJob: sql`EXISTS (
      SELECT 1 FROM jobs other
      WHERE other.issue_id = j.issue_id
        AND other.id <> j.id
        AND other.status IN ('dispatched','running','held')
    )`,
  };

  return { ctes, predicates };
}

/**
 * The gate-precedence CASE, shared by {@link assertDispatchable} and
 * {@link gateReasonsForQueuedJobs}. Expects `j`, `r` and
 * `fresh_capable_runners` in scope.
 */
function buildGateReasonCase(predicates: BarrierFragments['predicates']): SQL {
  return sql`
      CASE
        WHEN j.status <> 'queued' THEN 'not_queued'
        WHEN r.status <> 'running' THEN 'pipeline_run_not_running'
        WHEN j.retry_after_at IS NOT NULL AND j.retry_after_at > now() THEN 'retry_cooldown'
        WHEN ${predicates.issueBusySession} THEN 'issue_busy'
        WHEN ${predicates.issueBusyJob} THEN 'issue_busy'
        -- must too: uncorrelated, a project with no box of its own reads as served the moment ANY
        -- project in the set has one, which is the deadlock these arms exist to name, inverted.
        WHEN NOT EXISTS (
          SELECT 1 FROM fresh_capable_runners WHERE project_id = j.project_id
        ) THEN 'runner_stale'
        WHEN NOT EXISTS (
          SELECT 1 FROM fresh_capable_runners WHERE project_id = j.project_id AND claim_capable
        )
          THEN 'runner_too_old'
        -- ISS-1128 — a question about the JOB: may anything that could claim
        -- take it. Since the label became a preference, and since ISS-1275 made
        -- no preference admit the pool, that leaves one shape: two live deploy
        -- bindings naming DIFFERENT labels, which resolves to no box to prefer
        -- and is a person's to reconcile. A box that merely carries the wrong
        -- label is ordinary routing and waits on nobody, and a project that
        -- declares nothing is not waiting either.
        WHEN j.type = 'release_batch'
          AND NOT EXISTS (
            SELECT 1 FROM fresh_capable_runners fcr
            WHERE fcr.project_id = j.project_id
              AND fcr.claim_capable AND ${runnerMayTakeJob(sql`fcr.labels`)}
          )
          THEN 'release_label_missing'
        ELSE NULL
      END`;
}

export async function assertDispatchable(
  jobId: string,
  exec: DispatchGateExecutor = db,
): Promise<DispatchBarrier> {
  const [job] = await exec
    .select({ projectId: jobs.projectId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) return { ok: false, reason: 'not_found', hint: jobId };

  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const { ctes, predicates } = buildBarrierFragments({
    projectIds: [job.projectId],
    livenessSeconds,
  });

  const rows = await exec.execute<{ reason: string | null }>(sql`
    WITH ${ctes}
    SELECT ${buildGateReasonCase(predicates)} AS reason
    FROM jobs j
    LEFT JOIN issues i ON i.id = j.issue_id
    JOIN pipeline_runs r ON r.id = j.pipeline_run_id
    WHERE j.id = ${jobId}
  `);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found', hint: jobId };
  if (row.reason === null) return { ok: true };
  return { ok: false, reason: row.reason as GateSkipReason };
}

export interface RunnerAvailability {
  /** Runners the picker considers selectable at all (online, fresh, not
   *  rate-limited, device not disabled). Zero ⇒ gate reason `runner_stale`. */
  total: number;
}

/**
 * How many runners the picker can currently choose from in `projectId`.
 *
 * Reads the picker's OWN `fresh_capable_runners` CTE, so no caller has to
 * restate the six-clause availability rule.
 */
export async function freshRunnerAvailability(projectId: string): Promise<RunnerAvailability> {
  const { ctes } = buildBarrierFragments({
    projectIds: [projectId],
    livenessSeconds: Math.floor(dispatchLivenessMs() / 1000),
  });
  const rows = await db.execute<{ total: number }>(sql`
    WITH ${ctes}
    SELECT COUNT(*) FILTER (WHERE claim_capable)::int AS total
    FROM fresh_capable_runners
  `);
  return { total: Number(rows[0]?.total ?? 0) };
}

/**
 * The gate a job is stuck behind, for every `queued` job in `projectId`.
 *
 * Read-only, one query. Jobs absent from the map are dispatchable right now.
 */
export async function gateReasonsForQueuedJobs(
  projectId: string,
): Promise<Map<string, GateSkipReason>> {
  return gateReasonsForQueuedJobsIn([projectId]);
}

export async function gateReasonsForQueuedJobsIn(
  projectIds: readonly string[],
): Promise<Map<string, GateSkipReason>> {
  const out = new Map<string, GateSkipReason>();
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return out;

  const { ctes, predicates } = buildBarrierFragments({
    projectIds: ids,
    livenessSeconds: Math.floor(dispatchLivenessMs() / 1000),
  });

  const rows = await db.execute<{ id: string; reason: string | null }>(sql`
    WITH ${ctes}
    SELECT j.id, ${buildGateReasonCase(predicates)} AS reason
    FROM jobs j
    LEFT JOIN issues i ON i.id = j.issue_id
    JOIN pipeline_runs r ON r.id = j.pipeline_run_id
    WHERE j.project_id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND j.status = 'queued'
  `);

  for (const row of rows) {
    if (row.reason !== null) out.set(row.id, row.reason as GateSkipReason);
  }
  return out;
}
