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
 * Two invariants, both with a regression assertion in `dispatch-gates.test.ts`:
 * no temporal predicate beyond `valid_until`, the heartbeat, runner load and
 * `retry_after_at` (ISS-197) — a `gate_at + N seconds` debouncer trips it; and
 * no writes from either reader. ISS-789's `stale_trigger` is the one reason
 * that never clears by waiting, so the write ending such a job lives in
 * `jobs/stale-trigger.ts`, not here.
 */

import { eq, type SQL, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { jobs } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import {
  RUNNER_CAPABILITIES,
  TRIGGER_STATUS_BY_JOB_TYPE,
  WORKING_STATUS_BY_JOB_TYPE,
} from '../pipeline/registry.js';
import { claimCapableSql, deviceCapSql } from '../runners/device-cap.js';
import { countInFlightForOneRunner } from './in-flight.js';

export type GateSkipReason =
  | 'not_found'
  | 'not_queued'
  | 'pipeline_run_not_running'
  | 'retry_cooldown'
  | 'issue_busy'
  | 'stale_trigger'
  // cm:guard every member here must be a string `buildGateReasonCase` can actually return, and every string it returns must be a member — `assertDispatchable` casts the raw CASE result into this union unchecked, so a mismatch is invisible to tsc. A name that outlives its arm is the failure mode: `release_decompose_pending` sat here for months naming an arm that never existed, and `observability/hold-metrics.ts` keyed its counter Map by a value outside its own key type.
  | 'runner_full'
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
// cm:guard every dispatch gate must require pr.status IN ('running','paused') or a terminal-parent orphan wedges the runner cap
// cm:edge sideeffect -> packages/core/drizzle/migrations/0113_i1_orphan_trigger.sql — a DB trigger also cancels active jobs under terminal runs
export async function countInFlightForRunner(runnerId: string): Promise<number> {
  return countInFlightForOneRunner(runnerId);
}

export interface BarrierFragments {
  /** Shared CTE chunk: `device_load`, `fresh_capable_runners`.
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
    /** L1b — the job's declared trigger (`payload.stageStatus`) is no longer
     *  the issue's live status, so the stage would run on a trigger that has
     *  moved on. Scoped to the staged pipeline step types (so the autonomous
     *  `drive` job, which owns the issue's whole walk, is never caught) and
     *  exempting each type's own in-flight `workingStatus` (so a code/fix
     *  retry is never caught). */
    staleTrigger: SQL;
  };
}

/**
 * SSOT — single builder for the dispatch-barrier CTEs + EXISTS-form
 * predicates used by both the picker (`pickNextDispatchableJobForProject`)
 * and the asserter ({@link assertDispatchable}).
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
 * `dispatch-gates.test.ts` keeps the two sites in lockstep — extending one
 * without extending the other will flip a recorded scenario from
 * `ok:false` ⇔ "picker would not pick".
 */
// cm:edge contract -> packages/core/src/admin/alert-queries.ts — A3 (alertRunnerStarved) replays BOTH halves of this builder per project: the predicates, so a job held by issue-busy / retry-cooldown / a stale trigger is not miscounted as runner starvation, AND `fresh_capable_runners`, whose clauses are the definition of a usable runner. A3 inverts only the runner EXISTS; a gate added here and not replayed there turns a correctly-held queue into a false alert, and a runner clause added here alone makes a genuinely starved queue report ok.
export function buildBarrierFragments(args: {
  projectIdRef: SQL;
  livenessSeconds: number;
}): BarrierFragments {
  const { projectIdRef, livenessSeconds } = args;

  // cm:guard `cap` and `in_flight` are BOTH per device, and neither may drift back to the binding. A job consumes one Claude process on one machine, so a box bound to 20 projects at cap 3 runs 3 jobs in total — pairing a device cap with a per-binding count would authorise 20x that while every gate read as if it were holding.
  // cm:edge lockstep -> packages/core/src/runners/device-cap.ts#effectiveDeviceCap — the SQL half of the cap decision; the locked claim allocates on the TS half, so a SQL expression more generous than the TS one offers work the claim refuses every tick, forever, with no gate reason
  const ctes = sql`    device_load AS (
      -- ISS-258 -- exclude jobs whose parent pipeline_run is terminal so an
      -- orphan (cascade missed, manual SQL fix, partial-outage state drift)
      -- never burns the runner cap slot. The cascade in pipeline/runs.ts
      -- is the primary fix; this is defence in depth.
      SELECT j.device_id, COUNT(*)::int AS in_flight
      FROM jobs j
      LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
      WHERE j.device_id IS NOT NULL
        AND j.status IN ('dispatched','running')
        AND (pr.id IS NULL OR pr.status IN ('running','paused'))
      GROUP BY j.device_id
    ),
    fresh_capable_runners AS (
      SELECT r.id,
             ${deviceCapSql('d')} AS cap,
             COALESCE(dl.in_flight, 0) AS in_flight
      FROM runners r
      JOIN devices d ON d.id = r.device_id
      LEFT JOIN device_load dl ON dl.device_id = r.device_id
      WHERE r.project_id = ${projectIdRef}
        AND r.status = 'online'
        AND r.last_seen_at IS NOT NULL
        AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        -- cm:guard every clause runners/select.ts filters on MUST appear here too, or the pair deadlocks silently: the picker counts the runner as available and declares the job dispatchable, selectRunnerForJob then filters it out and returns null, handleDispatch skips, and the job spins "queued" with NO gate reason for any UI to show. Measured 2026-08-14: 11 jobs across 5 projects sat 6-22 days in exactly that state.
        AND (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
        -- cm:guard an auth limit has NO reset time by design ("rate_limited_until" stays NULL, nothing parseable to wait for), so the time predicate above passes it and an auth-dead runner reads as healthy. It must be excluded by NAME, and no widening of quarantine removes that need: "maybeQuarantineRunner" only counts failures "classifyBoxFault" recognises, and an expired OAuth session is neither a preflight check nor an unclaimed dispatch — the runner claims the job, starts the agent, and the agent dies on the credential. That is how device dev1-ai013 took 421 jobs in 5.5h with "quarantined_until" still NULL.
        AND r.limit_reason IS DISTINCT FROM 'auth'
        -- cm:guard mirrors NOT_QUARANTINED in runners/select.ts — a quarantined runner was counted as available here, which is the deadlock above and is also what would have made the escalating backoff invisible: longer TTL, more days of a job queued with no reason
        AND (r.quarantined_until IS NULL OR r.quarantined_until <= now())
        -- cm:guard mirrors WORKSPACE_READY in runners/select.ts — NULL is a legacy row that predates the column and stays eligible; only an explicit non-ready value blocks
        AND (r.provision_status IS NULL OR r.provision_status = 'ready')
        -- cm:guard mirrors "claimCapableSql" in runners/device-cap.ts — a box below the claim floor is refused OUTRIGHT ("runner_too_old"), never degraded, so counting it here declares dispatchable a job no runner on that box can ever take. Backticks are forbidden in this CTE: it is a template literal, and one backtick in a comment ends it.
        AND ${claimCapableSql('d')}
        -- Device turn-off gate — MUST mirror runners/select.ts
        -- (NOT_DISABLED_DEVICE). Without it the picker/asserter counts a runner
        -- on a disabled device as available and declares the job dispatchable,
        -- but selectRunnerForJob filters that runner out, returns null,
        -- handleDispatch skips, and the job spins queued forever (picker offers,
        -- selector rejects). A disabled device's runner can keep heartbeating
        -- (status stays online), so status alone does not cover this.
        AND NOT EXISTS (
          SELECT 1 FROM devices d
          WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL
        )
    )`;

  // cm:guard key the allowance on the job TYPE, never on the stamped trigger — `POST /run-pipeline-step` exists to re-fire a stage WITHOUT bouncing the issue status, so it stamps `stageStatus = issue.status`; re-fire `code` at `developed`, the agent flips the issue to `in_progress`, and a trigger-keyed arm ('approved','in_progress') matches nothing while the real pair is ('developed','in_progress'). Same concept, same key, same reason as `JOB_TYPE_INFLIGHT_STATUS` in pipeline/recovery-verifier.ts.
  // cm:edge lockstep -> packages/core/src/pipeline/recovery-verifier.ts — `JOB_TYPE_INFLIGHT_STATUS` is the failure-path twin of this allowance (both answer "is this retry still wanted?"); a type present in one and absent from the other means the retry engine keeps a job alive that this gate then discards
  const workingStatusArms = Object.entries(WORKING_STATUS_BY_JOB_TYPE).map(
    ([jobType, working]) => sql`(j.type = ${jobType} AND i.status::text = ${working})`,
  );
  const workingStatusAllowance =
    workingStatusArms.length > 0
      ? sql` AND NOT (${sql.join(workingStatusArms, sql` OR `)})`
      : sql``;

  // cm:guard scope the gate to job types that HAVE a trigger status, i.e. the staged pipeline steps — `drive` is the one that must stay out, and leaving it in is unrecoverable rather than merely wrong: the autonomous driver is stamped `stageStatus:'open'` yet owns the issue's WHOLE walk, so a retry clone or a released-from-hold successor reads as stale the moment the driver has moved the issue anywhere, and `dispatchAutonomous` enqueues at the entry status only — nothing re-creates the job, and the issue is left permanently dead with zero jobs.
  // cm:edge lockstep -> packages/core/src/pipeline/recovery-verifier.ts — `JOB_TYPE_ENTRY_STATUS` is the twin of this scope (the same 8 keys, and `drive` absent from both for the reason above); NOT `JOB_TYPE_EXPECTED_EXIT_STATUS`, whose retired `staging: ['reopen']` entry names a type no status dispatches, so keying the scope off exit mappings would re-admit a type the registry has already dropped
  const gatedJobTypes = Object.keys(TRIGGER_STATUS_BY_JOB_TYPE);
  const stageJobTypeScope = sql`j.type IN (${sql.join(
    gatedJobTypes.map((t) => sql`${t}`),
    sql`, `,
  )})`;

  const predicates = {
    issueBusySession: sql`EXISTS (
      SELECT 1 FROM agent_sessions s
      WHERE s.status IN ('queued','running')
        AND (s.metadata->>'issueId') = j.issue_id::text
        AND (j.agent_session_id IS NULL OR s.id <> j.agent_session_id)
    )`,
    // cm:guard `held` belongs HERE and NOT in `device_load` — the asymmetry is the whole design (RFC 0002): absent from the load count it consumes no runner slot and may wait indefinitely, present here it stops a second job being enqueued for the same issue while the first waits
    // cm:edge lockstep -> packages/core/src/db/schema.ts — the `jobs_active_unique` partial index is the DB-level twin of this predicate; a status listed in one must be listed in the other or `enqueue` inserts the duplicate this gate refuses to dispatch
    issueBusyJob: sql`EXISTS (
      SELECT 1 FROM jobs other
      WHERE other.issue_id = j.issue_id
        AND other.id <> j.id
        AND other.status IN ('dispatched','running','held')
    )`,
    // cm:guard eligibility is the PRESENCE of `payload.stageStatus`, i.e. the enqueuer declaring which trigger this job answers — widening it to every job would reap the ones nothing declared a trigger for (`pm`, `custom`, PM-dispatched steps), and `j.issue_id IS NOT NULL` is what keeps the smoke canaries out (skills/smoke-verify.ts stamps a stage but inserts with a null issue).
    // cm:guard this arm must be read STRICTLY AFTER both issue_busy arms in `buildGateReasonCase` — a sibling job mid-flight is exactly when the issue legitimately sits at a status that is nobody's trigger, so judging staleness first turns "another step is working" into a discard of the step queued behind it.
    // cm:edge lockstep -> packages/core/src/jobs/stale-trigger.ts — that sweep is what makes this gate terminal instead of a permanent hide: `jobs_active_unique` covers `queued`, so a stale job merely skipped by the picker blocks the replacement job for the same (issue, type) forever.
    staleTrigger: sql`j.issue_id IS NOT NULL
      AND ${stageJobTypeScope}
      AND (j.payload->>'stageStatus') IS NOT NULL
      AND i.status IS NOT NULL
      AND i.status::text <> (j.payload->>'stageStatus')${workingStatusAllowance}`,
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
 * builder; the parity test in `dispatch-gates.test.ts` will fail if the two
 * sites disagree on any of 20 mixed scenarios.
 */
/**
 * The gate-precedence CASE, shared by {@link assertDispatchable} and
 * {@link gateReasonsForQueuedJobs}. Expects `j`, `r` and
 * `fresh_capable_runners` in scope.
 */
// cm:guard both readers MUST take the CASE from here — the arm order IS the answer (issue_busy before the stale-trigger arm before the two runner arms), so a second copy reports a different "most specific reason" for the same job and the two surfaces start contradicting each other.
function buildGateReasonCase(predicates: BarrierFragments['predicates']): SQL {
  return sql`
      CASE
        WHEN j.status <> 'queued' THEN 'not_queued'
        WHEN r.status <> 'running' THEN 'pipeline_run_not_running'
        WHEN j.retry_after_at IS NOT NULL AND j.retry_after_at > now() THEN 'retry_cooldown'
        WHEN ${predicates.issueBusySession} THEN 'issue_busy'
        WHEN ${predicates.issueBusyJob} THEN 'issue_busy'
        WHEN ${predicates.staleTrigger} THEN 'stale_trigger'
        WHEN NOT EXISTS (SELECT 1 FROM fresh_capable_runners) THEN 'runner_stale'
        WHEN NOT EXISTS (SELECT 1 FROM fresh_capable_runners WHERE in_flight < cap)
          THEN 'runner_full'
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
  /** Of those, how many have a free slot. Zero ⇒ gate reason `runner_full`. */
  withCapacity: number;
}

/**
 * How many runners the picker can currently choose from in `projectId`.
 *
 * Reads the picker's OWN `fresh_capable_runners` CTE, so no caller has to
 * restate the six-clause availability rule.
 */
// cm:guard take this from `buildBarrierFragments`, never a hand-copied WHERE — the availability rule is six clauses deep (online, heartbeat window, rate_limited_until, disabled device, …) and a second copy silently disagrees with the gate, which is how pipelineHealth came to report NO reason at all for jobs the picker was refusing (11 jobs, queued 6-22 days, measured 2026-08-14).
export async function freshRunnerAvailability(projectId: string): Promise<RunnerAvailability> {
  const { ctes } = buildBarrierFragments({
    projectIdRef: sql`${projectId}`,
    livenessSeconds: Math.floor(dispatchLivenessMs() / 1000),
  });
  const rows = await db.execute<{ total: number; with_capacity: number }>(sql`
    WITH ${ctes}
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE in_flight < cap)::int AS with_capacity
    FROM fresh_capable_runners
  `);
  const row = rows[0];
  return { total: Number(row?.total ?? 0), withCapacity: Number(row?.with_capacity ?? 0) };
}

/**
 * The gate a job is stuck behind, for every `queued` job in `projectId`.
 *
 * Read-only, one query. Jobs absent from the map are dispatchable right now.
 */
// cm:why `queued` alone cannot distinguish "about to run" from "will never run" — the gates are stateless by design (nothing is persisted on the row), so a job blocked forever is byte-identical to a healthy one. Measured 2026-08-14: 11 jobs had been queued 6-22 days across 5 projects and no surface anywhere could say why, which is why finding out took a hand-written script against production.
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
