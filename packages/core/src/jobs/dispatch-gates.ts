/**
 * ISS-162 — Stateless Gates. Nothing is persisted on the job row: a job
 * failing any gate is simply absent from the picker's SELECT, and the next
 * tick recomputes every gate from scratch.
 *
 * ISS-228 — one {@link buildBarrierFragments} builder feeds BOTH readers (the
 * picker's WHERE and the {@link buildGateReasonCase} CASE behind
 * {@link assertDispatchable} and {@link gateReasonsForQueuedJobs}), so
 * extending one can no longer drift the other — the failure mode ISS-226's
 * narrower L1-only mirror had to patch, and what lets a pg-boss-direct dispatch
 * enforce the full gate set. What each gate asserts is documented per-member on
 * {@link BarrierFragments}; the CASE arm order is the precedence between them.
 *
 * Two invariants, both with a regression assertion in `dispatch-gates.test.ts`:
 * no temporal predicate beyond `valid_until`, the L5 heartbeat, L4 runner-load
 * and `retry_after_at` (ISS-197) — a `gate_at + N seconds` debouncer trips it;
 * and no writes from either reader. ISS-789's `stale_trigger` is the one gate
 * that never clears by waiting, so the write ending such a job lives in
 * `jobs/stale-trigger.ts`, not here.
 */

import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { jobs, projects, runners } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  type PipelineConfig,
} from '../pipeline/pipeline-config-schema.js';
import { isBaseBranchStampable } from '../pipeline/pipeline-config-service.js';
import {
  RUNNER_CAPABILITIES,
  TRIGGER_STATUS_BY_JOB_TYPE,
  WORKING_STATUS_BY_JOB_TYPE,
} from '../pipeline/registry.js';

export type GateSkipReason =
  | 'not_found'
  | 'not_queued'
  | 'pipeline_run_not_running'
  | 'retry_cooldown'
  | 'issue_busy'
  | 'stale_trigger'
  | 'blocked_by'
  // cm:guard every member here must be a string `buildGateReasonCase` can actually return, and every string it returns must be a member — `assertDispatchable` casts the raw CASE result into this union unchecked, so a mismatch is invisible to tsc. `release_decompose_pending` sat here for months naming an arm that never existed while `decompose_children_pending`, the one that does, was absent, and `observability/hold-metrics.ts` keyed its counter Map by a value outside its own key type.
  | 'decompose_children_pending'
  | 'project_cap'
  | 'runner_full'
  | 'runner_stale';

export type GateResult =
  | { pass: true }
  | { pass: false; reason: GateSkipReason; hint?: string; metadata?: Record<string, unknown> };

/**
 * Discriminated union returned by {@link assertDispatchable}. `ok: false`
 * carries the first failing gate's reason — the asserter walks gates in the
 * same precedence order as the picker WHERE clause, so the reported reason
 * is the most specific one.
 */
export type DispatchBarrier = { ok: true } | { ok: false; reason: GateSkipReason; hint?: string };

const PASS: GateResult = { pass: true };

/**
 * DEFAULT per-project cap on simultaneously-active issues, applied to any
 * project that has not set `pipelineConfig.maxConcurrentIssues`. ISS-232
 * Phase 3 fixed this at 1 because multiple in-flight code/fix sessions on the
 * same repo race each other into merge conflicts (forge-code + forge-fix
 * branching off the same base, then colliding at release time). That remains
 * the safe default; {@link resolveProjectCap} lets an operator opt a project
 * into higher parallelism (independent issues only — dependent ones stay
 * serialized by the L1/L2 gates).
 */
export const DEFAULT_MAX_CONCURRENT_ISSUES = 1;

/**
 * Resolve the per-project concurrent-issue cap from
 * `projects.agent_config -> 'pipelineConfig' -> 'maxConcurrentIssues'`,
 * falling back to {@link DEFAULT_MAX_CONCURRENT_ISSUES} when unset, malformed,
 * or out of the schema's [1,20] range. A single indexed-PK lookup; the picker
 * calls it once per tick.
 *
 * Returned as a clamped integer so a hand-edited DB value can never widen the
 * gate past the schema ceiling (`pipeline-config-schema.ts` enforces the same
 * bound on the write path).
 */
export async function resolveProjectCap(projectId: string): Promise<number> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const raw = (row?.agentConfig as { pipelineConfig?: { maxConcurrentIssues?: unknown } } | null)
    ?.pipelineConfig?.maxConcurrentIssues;
  const n = typeof raw === 'number' ? Math.floor(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CONCURRENT_ISSUES;
  return Math.min(n, 20);
}

/**
 * ISS-639 — resolve the per-project concurrent-issue cap AND whether
 * `mergeStates.baseBranch` can stamp `merged_at` from the SAME single
 * `projects.agent_config` select (the picker/asserter's parity test assumes
 * exactly one `projects` select per call — see {@link resolveProjectCap}).
 * `baseStampable` gates whether the `closed`-without-merge bypass in
 * {@link buildBarrierFragments} applies (see `isBaseBranchStampable`).
 */
export async function resolveGateSettings(
  projectId: string,
): Promise<{ cap: number; baseStampable: boolean }> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const ac = (row?.agentConfig ?? {}) as { pipelineConfig?: Record<string, unknown> };
  const pc = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
  const rawCap = pc.maxConcurrentIssues as unknown;
  const capN = typeof rawCap === 'number' ? Math.floor(rawCap) : Number.NaN;
  const cap =
    !Number.isFinite(capN) || capN < 1 ? DEFAULT_MAX_CONCURRENT_ISSUES : Math.min(capN, 20);
  // Merge onto PIPELINE_CONFIG_DEFAULTS — mirrors getPipelineConfig's own
  // merge (pipeline-config-service.ts) so a project relying on the
  // `tested` stage's manual-by-default `states` entry (never persisted
  // since it's the default) is still detected as unstampable.
  const pipelineConfig: PipelineConfig = { ...PIPELINE_CONFIG_DEFAULTS, ...(pc as PipelineConfig) };
  const baseStampable = isBaseBranchStampable(pipelineConfig);
  return { cap, baseStampable };
}

/**
 * ISS-232 Phase 2 — runner cap is unified to 1 across every runner type.
 * The per-runner `capabilities.maxConcurrent` override is dropped (it was
 * unused outside synthetic tests and the antigravity-as-load-balancer
 * path the v2 spec replaces). Keeping the constant exported so telemetry
 * + tests stay decoupled from the in-CTE literal.
 */
export const RUNNER_CAP_PER_RUNNER = 1;

/**
 * Runner ↔ job-type capability gate. Sourced from the pipeline registry
 * (single SSOT — see `pipeline/registry.ts`). The dispatcher consults this
 * immediately after `selectRunnerForJob`; a mismatched (runner.type,
 * job.type) pair fails the job permanently with
 * `runner_unsupported_type:<runner-type>`.
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
 * @deprecated ISS-228 — superseded by {@link assertDispatchable}, which
 * mirrors the FULL picker gate set (blocked_by, project_cap,
 * runner_full, …) and not just L1 issue_busy. Kept exported so the legacy
 * mock-based tests can still exercise the L1 SQL shape; new callers must
 * route through `assertDispatchable`.
 */
export async function hasNonTerminalPriorSession(
  issueId: string,
  excludeSessionId?: string | null,
): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1
    FROM agent_sessions
    WHERE status IN ('queued','running')
      AND metadata->>'issueId' = ${issueId}
      ${excludeSessionId ? sql`AND id <> ${excludeSessionId}` : sql``}
    LIMIT 1
  `);
  return rows.length > 0;
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
  const rows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM jobs j
    LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    WHERE j.runner_id = ${runnerId}
      AND j.status IN ('dispatched', 'running')
      AND (pr.id IS NULL OR pr.status IN ('running', 'paused'))
  `);
  return Number(rows[0]?.count ?? '0');
}

/**
 * L5 — runner heartbeat freshness. Returns `pass` when the runner has
 * pinged inside the dispatch-liveness window; otherwise reports the
 * runner_stale skip reason with the observed `lastSeenAgoMs`. Used by tests
 * + telemetry — the actual gate is enforced by `selectRunnerForJob`'s SQL
 * (a stale runner is silently absent from the SELECT result).
 */
export async function checkLayer5RunnerHeartbeat(runnerId: string): Promise<GateResult> {
  const [runner] = await db
    .select({ lastSeenAt: runners.lastSeenAt })
    .from(runners)
    .where(eq(runners.id, runnerId))
    .limit(1);
  if (!runner) return PASS;
  const lastSeen = runner.lastSeenAt ? new Date(runner.lastSeenAt).getTime() : null;
  if (lastSeen === null) {
    return {
      pass: false,
      reason: 'runner_stale',
      hint: 'runner has never pinged',
      metadata: { runnerId, lastSeenAgoMs: null },
    };
  }
  const ageMs = Date.now() - lastSeen;
  if (ageMs > dispatchLivenessMs()) {
    return {
      pass: false,
      reason: 'runner_stale',
      hint: `runner heartbeat ${Math.round(ageMs / 1000)}s old`,
      metadata: { runnerId, lastSeenAgoMs: ageMs },
    };
  }
  return PASS;
}

/**
 * L4 — in-flight jobs on the chosen runner < runner cap. `excludeJobId` lets
 * the caller skip the candidate job (e.g. when re-checking after a transient
 * skip-and-requeue).
 *
 * Retained as a defence-in-depth helper for telemetry + tests. ISS-198 moved
 * the production gate into the picker SQL (see {@link pickNextDispatchableJobForProject}).
 */
export async function checkLayer4RunnerFull(
  runnerId: string,
  options?: { excludeJobId?: string },
): Promise<GateResult> {
  const [runner] = await db
    .select({ type: runners.type })
    .from(runners)
    .where(eq(runners.id, runnerId))
    .limit(1);
  if (!runner) return PASS; // Runner vanished; let the dispatcher hit its own no-runner branch.

  const cap = RUNNER_CAP_PER_RUNNER;
  // ISS-258 — same orphan-aware filter as countInFlightForRunner: jobs
  // whose parent pipeline_run is terminal must not count toward the cap.
  const rows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM jobs j
    LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    WHERE j.runner_id = ${runnerId}
      AND j.status IN ('dispatched', 'running')
      AND (pr.id IS NULL OR pr.status IN ('running', 'paused'))
      ${options?.excludeJobId ? sql`AND j.id <> ${options.excludeJobId}` : sql``}
  `);
  const inFlight = Number(rows[0]?.count ?? '0');
  if (inFlight >= cap) {
    return {
      pass: false,
      reason: 'runner_full',
      hint: `runner ${inFlight}/${cap} in-flight`,
      metadata: { cap, inFlight, runnerId },
    };
  }
  return PASS;
}

/**
 * AUTHORITATIVE per-runner cap enforcement at dispatch time, race-safe.
 *
 * The picker's L4 EXISTS gate is pool-coarse (it proves SOME runner is free, not
 * that the SELECTED one is), and `maxConcurrentIssues>1` lets two ticks target
 * the same free runner concurrently. This claims a runner slot atomically:
 *   1. `SELECT … FOR UPDATE` the runner row → serializes concurrent dispatches
 *      to the SAME host (other claimers block until this tx commits).
 *   2. recount orphan-aware in-flight under the lock (mirrors
 *      {@link countInFlightForRunner} — terminal-parent orphans don't count).
 *   3. only if a slot is free, CAS the job `queued → dispatched` on this runner.
 *
 * Returns `'claimed'` on success, `'runner_full'` if the runner is already at
 * {@link RUNNER_CAP_PER_RUNNER} (caller leaves the job queued for a later tick),
 * or `'lost'` if the job was no longer `queued` (another dispatcher won the CAS).
 * Makes exceeding the per-runner cap IMPOSSIBLE regardless of dispatch races.
 */
export async function claimRunnerSlot(args: {
  jobId: string;
  runnerId: string;
  deviceId: string | null;
  dispatchedAt: Date;
}): Promise<'claimed' | 'runner_full' | 'lost'> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM runners WHERE id = ${args.runnerId} FOR UPDATE`);
    const rows = await tx.execute<{ in_flight: number }>(sql`
      SELECT COUNT(*)::int AS in_flight
      FROM jobs j
      LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
      WHERE j.runner_id = ${args.runnerId}
        AND j.status IN ('dispatched','running')
        AND (pr.id IS NULL OR pr.status IN ('running','paused'))
    `);
    if (Number(rows[0]?.in_flight ?? 0) >= RUNNER_CAP_PER_RUNNER) return 'runner_full' as const;
    const upd = await tx
      .update(jobs)
      .set({
        status: 'dispatched',
        runnerId: args.runnerId,
        deviceId: args.deviceId,
        dispatchedAt: args.dispatchedAt,
      })
      .where(and(eq(jobs.id, args.jobId), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id });
    return upd.length > 0 ? ('claimed' as const) : ('lost' as const);
  });
}

type JobRow = typeof jobs.$inferSelect;

interface BarrierFragments {
  /** Shared CTE chunk: `running_ids`, `runner_load`, `fresh_capable_runners`.
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
    /** L2 — at least one `kind='blocks'` dependency parent is non-terminal.
     *  Folded `j.type <> 'pm'` into the predicate so PM jobs auto-skip the
     *  gate (PM has no issue deps). */
    blockedBy: SQL;
    /** L2 — a decompose PARENT's forward jobs (code/review/test/fix) wait
     *  until every `kind='decomposes'` child has landed on base
     *  (`child.merged_at` set). Parent runs its integration last; children are
     *  NOT gated on the parent. */
    decomposeChildrenPending: SQL;
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
 * project_cap and runner-availability EXISTS checks). The parity test in
 * `dispatch-gates.test.ts` keeps the two sites in lockstep — extending one
 * without extending the other will flip a recorded scenario from
 * `ok:false` ⇔ "picker would not pick".
 */
function buildBarrierFragments(args: {
  projectIdRef: SQL;
  livenessSeconds: number;
  baseStampable: boolean;
}): BarrierFragments {
  const { projectIdRef, livenessSeconds, baseStampable } = args;

  // ISS-232 Phase 2 — `running_ids` is sourced exclusively from `jobs`
  // (queued | dispatched | running). The previous UNION with
  // `agent_sessions` mixed concerns: agent_session rows lag the job
  // lifecycle, so an in-flight job whose session row hadn't landed yet
  // (or whose session had failed-and-rebooted) was double-counted in
  // one direction, under-counted in the other. The jobs table is the
  // authoritative ledger — every dispatched job has a row, every retry
  // burst is captured by `status='queued' AND retry_after_at > now()`.
  // Issues with a queued retry-cooldown job still hold their slot so a
  // worker-wide rate-limit can't release it to an unrelated issue.
  //
  // `fresh_capable_runners` lost the per-runner `maxConcurrent` override
  // and the antigravity 5-slot case branch — cap is hardcoded to 1 for
  // every runner type (claude-code processes Claude CLI serially; the
  // antigravity exception was load-balance-by-capacity, which the v2
  // spec replaces with primary-pinned selection).
  const ctes = sql`running_ids AS (
      SELECT DISTINCT issue_id::text AS issue_id
      FROM jobs
      WHERE project_id = ${projectIdRef}
        AND issue_id IS NOT NULL
        AND (
          status IN ('dispatched','running')
          OR (
            status = 'queued'
            AND retry_after_at IS NOT NULL
            AND retry_after_at > now()
          )
        )
    ),
    runner_load AS (
      -- ISS-258 -- exclude jobs whose parent pipeline_run is terminal so an
      -- orphan (cascade missed, manual SQL fix, partial-outage state drift)
      -- never burns the runner cap slot. The cascade in pipeline/runs.ts
      -- is the primary fix; this is defence in depth.
      SELECT j.runner_id, COUNT(*)::int AS in_flight
      FROM jobs j
      LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
      WHERE j.runner_id IS NOT NULL
        AND j.status IN ('dispatched','running')
        AND (pr.id IS NULL OR pr.status IN ('running','paused'))
      GROUP BY j.runner_id
    ),
    fresh_capable_runners AS (
      SELECT r.id,
             1 AS cap,
             COALESCE(rl.in_flight, 0) AS in_flight
      FROM runners r
      LEFT JOIN runner_load rl ON rl.runner_id = r.id
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
        -- Device turn-off gate — MUST mirror runners/select.ts
        -- (NOT_DISABLED_DEVICE). Without it the picker/asserter counts a runner
        -- on a disabled device as available and declares the job dispatchable,
        -- but selectRunnerForJob filters that runner out, returns null,
        -- handleDispatch skips, and the job spins queued forever (picker offers,
        -- selector rejects). A disabled device's runner can keep heartbeating
        -- (status stays online), so status alone does not cover this.
        -- Remote/server runners (NULL device_id) have no device row, so the
        -- NOT EXISTS holds and they stay eligible.
        AND NOT EXISTS (
          SELECT 1 FROM devices d
          WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL
        )
    )`;

  // cm:guard ISS-639 — the `OR status='closed'` bypass is legal ONLY while the project's base branch is structurally unstampable (manual mode / auto-toggle off, per `isBaseBranchStampable`). On an auto-advancing base a `closed` blocker with `merged_at IS NULL` was closed WITHOUT its code landing, so the dependent must NOT dispatch; re-adding the arm unconditionally is the devbox ISS-2/ISS-4 bug.
  // cm:edge lockstep -> packages/core/src/pipeline/sweeper.ts — `alarmClosedUnmergedBlockedDependents` (sweeper.ts) and `alarmUnrunnableBlockedDependents` (blocked-dependent-alarms.ts, covering `draft` AND `dropped`) are the surfacing halves of this predicate: this decides which blockers hold a job, those decide what the operator is told about it. A blocker status added or dropped here and not there is a job queued with nobody notified. (This comment named `parkClosedUnmergedBlockedDependents` for months after RFC 0002 renamed it and removed the park.)
  const blockClosedArm = baseStampable ? sql`` : sql` AND p.status <> 'closed'`;
  const decompClosedArm = baseStampable ? sql`` : sql` AND c2.status <> 'closed'`;

  // cm:guard treat a currently-reopened blocker as UNSATISFIED regardless of merged_at — the stamp is COALESCE-once and never cleared, so a blocker that reached `tested` then got rejected back to `reopen` still reads as satisfied and dispatches the parent onto a broken child (sid-desk ISS-20/25); the stamp records that code landed once, not that it is still good
  //
  // cm:why ONLY `reopen` — `on_hold`/`needs_info` were considered and rejected. Over-blocking wedges a queue silently (the ISS-639 failure mode this file was already burned by); `reopen` is the only bounce that asserts the landed code itself is suspect.
  const blockReopenArm = sql` OR p.status = 'reopen'`;
  const decompReopenArm = sql` OR c2.status = 'reopen'`;

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
  // cm:edge lockstep -> packages/core/src/pipeline/recovery-verifier.ts — `JOB_TYPE_EXPECTED_EXIT_STATUS.drive` is deliberately EMPTY for this same reason ("the driver owns the issue's whole walk"); a job type given an exit mapping there belongs in this scope, and one taken away must leave it
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
    // cm:guard `held` belongs HERE and in NEITHER `running_ids` nor `runner_load` — the asymmetry is the whole design (RFC 0002): absent from those two it consumes no project-serial or runner-cap slot and may wait indefinitely, present here it stops the reconciler enqueueing a second job for the same issue while the first waits
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
    // ISS-232 — Layer 2 is git-aware: a `blocks` parent is satisfied when its
    // `merged_at` is stamped (transition out of `pipelineConfig.mergeStates
    // .baseBranch`, see `issues/merged-at.ts:markMergedIfLeavingBase`), OR —
    // ONLY when the base branch is structurally unstampable — when it is
    // `closed`. The `OR status='closed'` arm covers skill-driven-merge
    // projects (e.g. dodgeprint: mergeStates points at a manual/toggle-off
    // stage, so `merged_at` never stamps). Without it, a sibling-`blocks`
    // chain wedges the moment the first blocker closes. Operator manual
    // override stays a direct `UPDATE issues SET merged_at = now()` (or the
    // `mark_merged` MCP action).
    blockedBy: sql`j.type <> 'pm' AND EXISTS (
      SELECT 1 FROM issue_dependencies d
      JOIN issues p ON p.id = d.from_issue_id
      WHERE d.to_issue_id = j.issue_id
        AND d.kind = 'blocks'
        AND (d.valid_until IS NULL OR d.valid_until > now())
        AND (p.merged_at IS NULL${blockReopenArm})${blockClosedArm}
    )`,
    // Decompose redesign — the PARENT runs its integration LAST. A decompose
    // parent's forward jobs (code/review/test/fix) stay queued until every
    // `kind='decomposes'` child is satisfied — `merged_at` stamped OR (ONLY
    // under a structurally-unstampable base) `closed` — same satisfaction
    // rule as `blockedBy` above.
    // Children are NOT gated on the parent: the old `releaseDecomposePending`
    // gate (child release waited for `parent.merged_at`) deadlocked umbrella
    // epics that never code-merge themselves, so it was removed. The
    // dependency is now one-directional: parent waits for children.
    decomposeChildrenPending: sql`j.type IN ('code','review','test','fix') AND EXISTS (
      SELECT 1 FROM issue_dependencies d2
      JOIN issues c2 ON c2.id = d2.to_issue_id
      WHERE d2.from_issue_id = j.issue_id
        AND d2.kind = 'decomposes'
        AND (d2.valid_until IS NULL OR d2.valid_until > now())
        AND (c2.merged_at IS NULL${decompReopenArm})${decompClosedArm}
    )`,
  };

  return { ctes, predicates };
}

// The per-project cap is resolved by `resolveProjectCap` (above) from
// `pipelineConfig.maxConcurrentIssues`, defaulting to
// `DEFAULT_MAX_CONCURRENT_ISSUES` (= 1). ISS-232 Phase 3 had hardcoded it to 1
// for the v2 serial-per-project invariant; the knob was later re-added as an
// opt-in so operators can fan INDEPENDENT issues across the pool without
// standing up separate projects (dependent issues stay serialized by the
// L1/L2 gates regardless of the cap).

/**
 * Pick the next queued job that satisfies L1/L2/L3/L4/L5 inline, or null if
 * no such job exists. Ordering:
 *   priority DESC (critical>high>medium>low>none>null),
 *   then the parent `pipeline_run.started_at ASC` (run cohesion — ISS-101),
 *   then `queued_at ASC` as a final tiebreaker.
 * Same-priority tier: every job of the oldest run drains before a newer
 * run's first job gets dispatched. Higher priority on a newer run still
 * preempts because the priority key is applied before the run-age key.
 *
 * Closed/cancelled runs are filtered via `r.status = 'running'` — defence
 * in depth on top of the terminal-issue cascade that already moves jobs out
 * of `queued`.
 */
// cm:flow dispatch/gate after:tick — the four layers decide whether ANY queued job may go out now; returning null is the normal answer, not a fault
export async function pickNextDispatchableJobForProject(
  projectId: string,
  opts?: { excludeJobIds?: string[] },
): Promise<JobRow | null> {
  const { cap, baseStampable } = await resolveGateSettings(projectId);
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const { ctes, predicates } = buildBarrierFragments({
    projectIdRef: sql`${projectId}`,
    livenessSeconds,
    baseStampable,
  });
  // Jobs the current dispatch tick already tried and could not PLACE (e.g. a
  // resume pinned to a busy host, or no capable free runner). Excluding them
  // lets the stateless picker return the NEXT candidate instead of the same
  // head-of-line job, so an unplaceable job never blocks independent issues
  // that can go to a free runner. Empty on the first pick of a tick.
  const excludeJobIds = opts?.excludeJobIds ?? [];
  const excludeClause =
    excludeJobIds.length > 0
      ? sql`AND j.id NOT IN (${sql.join(
          excludeJobIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;

  const rows = await db.execute<JobRow>(sql`
    WITH ${ctes}
    SELECT j.*
    FROM jobs j
    LEFT JOIN issues i ON i.id = j.issue_id
    JOIN pipeline_runs r ON r.id = j.pipeline_run_id
    WHERE j.project_id = ${projectId}
      AND j.status = 'queued'
      AND j.type <> 'pm'
      AND r.status = 'running'
      ${excludeClause}
      -- ISS-197 — L1 cooldown gate. retry_after_at is set by the retry
      -- engine when honouring a provider Retry-After hint; until the
      -- timestamp passes, the job is invisible to the picker.
      AND (j.retry_after_at IS NULL OR j.retry_after_at <= now())
      AND NOT (${predicates.issueBusySession})
      AND NOT (${predicates.issueBusyJob})
      AND NOT (${predicates.staleTrigger})
      AND NOT (${predicates.blockedBy})
      AND NOT (${predicates.decomposeChildrenPending})
      AND EXISTS (
        SELECT 1 FROM fresh_capable_runners fcr
        WHERE fcr.in_flight < fcr.cap
      )
      AND (
        j.issue_id::text IN (SELECT issue_id FROM running_ids)
        OR (SELECT COUNT(*) FROM running_ids) < ${cap}
      )
    ORDER BY
      CASE COALESCE(i.priority, 'none')
        WHEN 'critical' THEN 0
        WHEN 'high'     THEN 1
        WHEN 'medium'   THEN 2
        WHEN 'low'      THEN 3
        WHEN 'none'     THEN 4
        ELSE 5
      END,
      r.started_at ASC,
      j.queued_at ASC
    LIMIT 1
  `);
  return rows.length > 0 ? (rows[0] ?? null) : null;
}

/**
 * Single-job gate check. Mirrors EVERY predicate in
 * {@link pickNextDispatchableJobForProject}. Use from `handleDispatch` /
 * `handlePmDispatch` to enforce the same invariants when pg-boss delivers
 * a job directly (bypassing the picker on first delivery, retry burst,
 * reconciler rescue, etc.).
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
 * {@link gateReasonsForQueuedJobs}. Expects `j`, `r`, `running_ids` and
 * `fresh_capable_runners` in scope.
 */
// cm:guard both readers MUST take the CASE from here — the arm order IS the answer (issue_busy before blocked_by before project_cap before the two runner arms), so a second copy reports a different "most specific reason" for the same job and the two surfaces start contradicting each other. This is the same one-builder rule `buildBarrierFragments` already enforces for the picker/asserter pair.
function buildGateReasonCase(predicates: BarrierFragments['predicates'], cap: number): SQL {
  return sql`
      CASE
        WHEN j.status <> 'queued' THEN 'not_queued'
        WHEN r.status <> 'running' THEN 'pipeline_run_not_running'
        WHEN j.retry_after_at IS NOT NULL AND j.retry_after_at > now() THEN 'retry_cooldown'
        WHEN ${predicates.issueBusySession} THEN 'issue_busy'
        WHEN ${predicates.issueBusyJob} THEN 'issue_busy'
        WHEN ${predicates.staleTrigger} THEN 'stale_trigger'
        WHEN ${predicates.blockedBy} THEN 'blocked_by'
        WHEN ${predicates.decomposeChildrenPending} THEN 'decompose_children_pending'
        WHEN j.issue_id IS NOT NULL
             AND j.issue_id::text NOT IN (SELECT issue_id FROM running_ids)
             AND (SELECT COUNT(*) FROM running_ids) >= ${cap}
          THEN 'project_cap'
        WHEN NOT EXISTS (SELECT 1 FROM fresh_capable_runners) THEN 'runner_stale'
        WHEN NOT EXISTS (SELECT 1 FROM fresh_capable_runners WHERE in_flight < cap)
          THEN 'runner_full'
        ELSE NULL
      END`;
}

export async function assertDispatchable(jobId: string): Promise<DispatchBarrier> {
  const [job] = await db
    .select({ projectId: jobs.projectId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) return { ok: false, reason: 'not_found', hint: jobId };

  const { cap, baseStampable } = await resolveGateSettings(job.projectId);
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const { ctes, predicates } = buildBarrierFragments({
    projectIdRef: sql`${job.projectId}`,
    livenessSeconds,
    baseStampable,
  });

  const rows = await db.execute<{ reason: string | null }>(sql`
    WITH ${ctes}
    SELECT ${buildGateReasonCase(predicates, cap)} AS reason
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
// cm:why `baseStampable` is arbitrary here — it shapes only the dependency PREDICATES, never the CTEs, and this reads nothing but the CTE
export async function freshRunnerAvailability(projectId: string): Promise<RunnerAvailability> {
  const { ctes } = buildBarrierFragments({
    projectIdRef: sql`${projectId}`,
    livenessSeconds: Math.floor(dispatchLivenessMs() / 1000),
    baseStampable: false,
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
  const { cap, baseStampable } = await resolveGateSettings(projectId);
  const { ctes, predicates } = buildBarrierFragments({
    projectIdRef: sql`${projectId}`,
    livenessSeconds: Math.floor(dispatchLivenessMs() / 1000),
    baseStampable,
  });

  const rows = await db.execute<{ id: string; reason: string | null }>(sql`
    WITH ${ctes}
    SELECT j.id, ${buildGateReasonCase(predicates, cap)} AS reason
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
