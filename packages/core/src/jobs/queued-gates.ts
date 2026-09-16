/**
 * Why a `queued` job is not being worked — the EXPLAINER, not a gate.
 *
 * Nothing here decides anything: routing is the master agent's, and the one
 * condition core still enforces lives in `devices/claim.ts`. What this owns is
 * the question `queued` cannot answer on its own — "about to run" and "will
 * never run" are byte-identical on the row — so every reason is recomputed
 * from scratch on read and nothing is persisted (ISS-162).
 *
 * ISS-228 — one {@link buildBarrierFragments} builder feeds both readers, so
 * extending one can no longer drift the other. The CASE arm order is the
 * precedence between them.
 *
 * Two invariants, both with a regression assertion in `queued-gates.test.ts`:
 * no temporal predicate beyond `valid_until`, the heartbeat, runner load and
 * `retry_after_at` (ISS-197) — a `gate_at + N seconds` debouncer trips it; and
 * no writes from either reader.
 */

import { eq, type SQL, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { jobs } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { RUNNER_CAPABILITIES } from '../pipeline/registry.js';
import { claimCapableSql } from '../runners/device-cap.js';
import { countInFlightForOneRunner } from './in-flight.js';

export type GateSkipReason =
  | 'not_found'
  | 'not_queued'
  | 'pipeline_run_not_running'
  | 'retry_cooldown'
  | 'issue_busy'
  | 'runner_too_old'
  | 'runner_stale';

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

/**
 * Count jobs currently in-flight (`dispatched|running`) on a runner. Exported
 * so the dispatcher's L4 check and tests can share the same query.
 *
 * ISS-258 — joins `pipeline_runs` and filters to non-terminal parents
 * (`running|paused`). An orphaned job whose parent run is already
 * `completed|failed|cancelled` no longer holds the runner's cap slot, so a
 * single missed cascade can't wedge the runner indefinitely (the Forge Dev
 * 2026-05-27 stall). The cascade in `runs.ts` is the primary defence; this
 * filter is the safety net for state drift.
 */
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
    /** L1 — non-terminal agent_session for this issue (excluding the
     *  candidate's own linked session). Mirrors the ISS-226 inline check
     *  the dispatcher used to perform separately. */
    issueBusySession: SQL;
    /** L1 — sibling job (`dispatched|running`) already running for this
     *  issue. Catches the same-issue race that L1 issueBusySession does
     *  not, e.g. an in-flight job whose agent_session row hasn't landed
     *  yet. */
    issueBusyJob: SQL;
  };
}

/**
 * SSOT — single builder for the dispatch-barrier CTEs + EXISTS-form
 * predicates used by both readers: {@link gateReasonsForQueuedJobs} and
 * {@link assertDispatchable}.
 *
 * All predicate SQL refers to the surrounding query's standard aliases:
 *   `j` — the jobs row
 *   `i` — the issues row (LEFT JOIN)
 *   `r` — the pipeline_runs row (JOIN)
 *
 * Both call sites are responsible for the matching FROM + JOIN block plus
 * the trivially-shared scalar checks (`j.status='queued'`, `r.status='running'`,
 * the `retry_after_at` cooldown, and the
 * runner-availability EXISTS checks). The parity test in
 * `queued-gates.test.ts` keeps the two sites in lockstep — extending one
 * without extending the other will flip a recorded scenario from
 * `ok:false` ⇔ "picker would not pick".
 */
export function buildBarrierFragments(args: {
  projectIdRef: SQL;
  livenessSeconds: number;
}): BarrierFragments {
  const { projectIdRef, livenessSeconds } = args;

  const ctes = sql`    fresh_capable_runners AS (
      SELECT r.id,
             ${claimCapableSql('d')} AS claim_capable
      FROM runners r
      JOIN devices d ON d.id = r.device_id
      WHERE r.project_id = ${projectIdRef}
        AND r.status = 'online'
        AND r.last_seen_at IS NOT NULL
        AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        AND (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
        AND r.limit_reason IS DISTINCT FROM 'auth'
        AND (r.quarantined_until IS NULL OR r.quarantined_until <= now())
        AND (r.provision_status IS NULL OR r.provision_status = 'ready')
        -- Device turn-off gate — MUST mirror runners/select.ts
        -- (NOT_DISABLED_DEVICE). Without it the picker/asserter counts a runner
        -- on a disabled device as available and declares the job dispatchable,
        -- but the candidate query filters that runner out, so the job sits
        -- queued while this gate reports it ready. A disabled device's runner
        -- can keep heartbeating
        -- (status stays online), so status alone does not cover this.
        AND NOT EXISTS (
          SELECT 1 FROM devices d
          WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL
        )
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
 * Why one job is not claimable right now, or `ok` when nothing holds it.
 *
 * Precedence of WHEN clauses matches the picker's WHERE order so the
 * reported reason is the most specific one. The CASE returns NULL when the
 * job is dispatchable.
 *
 * EXISTS predicates come from {@link buildBarrierFragments} — same builder
 * the picker uses. New gates that touch EXISTS sub-queries must extend the
 * builder; the parity test in `queued-gates.test.ts` will fail if the two
 * sites disagree on any of 20 mixed scenarios.
 */
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
        WHEN NOT EXISTS (SELECT 1 FROM fresh_capable_runners) THEN 'runner_stale'
        WHEN NOT EXISTS (SELECT 1 FROM fresh_capable_runners WHERE claim_capable)
          THEN 'runner_too_old'
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
    projectIdRef: sql`${job.projectId}`,
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
    projectIdRef: sql`${projectId}`,
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
  const { ctes, predicates } = buildBarrierFragments({
    projectIdRef: sql`${projectId}`,
    livenessSeconds: Math.floor(dispatchLivenessMs() / 1000),
  });

  const rows = await db.execute<{ id: string; reason: string | null }>(sql`
    WITH ${ctes}
    SELECT j.id, ${buildGateReasonCase(predicates)} AS reason
    FROM jobs j
    LEFT JOIN issues i ON i.id = j.issue_id
    JOIN pipeline_runs r ON r.id = j.pipeline_run_id
    WHERE j.project_id = ${projectId}
      AND j.status = 'queued'
  `);

  const out = new Map<string, GateSkipReason>();
  for (const row of rows) {
    if (row.reason !== null) out.set(row.id, row.reason as GateSkipReason);
  }
  return out;
}
