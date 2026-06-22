/**
 * ISS-162 — Stateless Gates. `pickNextDispatchableJobForProject` evaluates
 * the gate layers inline on every call; no gate signal is persisted on
 * the job row. A job that fails any gate is simply absent from the SELECT
 * result, and the next tick recomputes the gate from scratch.
 *
 * ISS-228 — Single SSOT dispatch barrier. The picker SELECT and the
 * {@link assertDispatchable} CASE share one {@link buildBarrierFragments}
 * builder for (a) the `running_ids` / `runner_load` / `fresh_capable_runners`
 * CTEs and (b) the EXISTS sub-queries that encode each gate. Two call sites,
 * one source of truth — so a future contributor extending one gate can no
 * longer drift the other (the failure mode that ISS-226's narrower L1 mirror
 * had to patch). pg-boss-direct dispatches now enforce the full gate set
 * (blocked_by, project_cap, runner_full, retry_cooldown,
 * pipeline_run_running) instead of just L1 issue_busy.
 *
 * Gate layers (single-source, see {@link buildBarrierFragments}):
 *   L1 issue_busy               — at most one active session per issue
 *   L2 waiting_on_dep / decomp  — every `kind='blocks'` parent must be
 *                                 terminal; release jobs additionally wait
 *                                 for their `kind='decomposes'` parent
 *   L3 project_full              — DISTINCT running issue_ids per project
 *                                 must be below the project cap (or the
 *                                 candidate's own issue is already counted)
 *   L4 runner_full + L5 runner_heartbeat — selectable runners must be online,
 *                                 fresh per the dispatch-liveness window, AND
 *                                 have free capacity. Implemented inline in
 *                                 `fresh_capable_runners`.
 *
 * Invariants:
 *   - No temporal predicates beyond dependency-edge `valid_until` expiry,
 *     stale-runner heartbeat (L5), runner-load (L4), and `retry_after_at`
 *     (ISS-197). A future contributor adding a `gate_at + N seconds`
 *     debouncer should trip the regression assertion in
 *     `dispatch-gates.test.ts`.
 *   - No writes from the picker / asserter. Both are read-only.
 */

import { type SQL, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, runners } from '../db/schema.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { RUNNER_CAPABILITIES } from '../pipeline/registry.js';

export type GateSkipReason =
  | 'not_found'
  | 'not_queued'
  | 'pipeline_run_not_running'
  | 'retry_cooldown'
  | 'issue_busy'
  | 'blocked_by'
  | 'release_decompose_pending'
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
 * Per-project cap on simultaneously-active issues. ISS-232 Phase 3 fixed
 * this at 1 and removed the `pipelineConfig.maxConcurrentIssues` knob.
 * Rationale: multiple in-flight code/fix sessions on the same repo race
 * each other into merge conflicts (forge-code + forge-fix branching off
 * the same base, then colliding at release time), and the v2 spec's
 * primary-pinned + serial-per-project invariants require this. Operators
 * who need higher parallelism run separate projects.
 */
export const DEFAULT_MAX_CONCURRENT_ISSUES = 1;

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
}): BarrierFragments {
  const { projectIdRef, livenessSeconds } = args;

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
        -- Rate/usage-limited runners are unavailable until their reset time.
        -- rate_limited_until is NULL for auth limits (no auto-recovery), so
        -- those do not gate here; they keep failing and trip the breaker.
        AND (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
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
        AND other.status IN ('dispatched','running')
    )`,
    // ISS-232 — Layer 2 is git-aware: a `blocks` parent is satisfied when its
    // `merged_at` is stamped (transition out of `pipelineConfig.mergeStates
    // .baseBranch`, see `issues/merged-at.ts:markMergedIfLeavingBase`), OR when
    // it is `closed`. The `OR status='closed'` arm covers skill-driven-merge
    // projects (e.g. dodgeprint: mergeStates UNSET + issues close via
    // `in_progress→closed` without ever leaving `released`, so `merged_at`
    // never stamps). Without it, a sibling-`blocks` chain wedges the moment the
    // first blocker closes. A closed issue is terminally done regardless of
    // how its merge was recorded. Operator manual override stays a direct
    // `UPDATE issues SET merged_at = now()` (or the `mark_merged` MCP action).
    blockedBy: sql`j.type <> 'pm' AND EXISTS (
      SELECT 1 FROM issue_dependencies d
      JOIN issues p ON p.id = d.from_issue_id
      WHERE d.to_issue_id = j.issue_id
        AND d.kind = 'blocks'
        AND (d.valid_until IS NULL OR d.valid_until > now())
        AND p.merged_at IS NULL
        AND p.status <> 'closed'
    )`,
    // Decompose redesign — the PARENT runs its integration LAST. A decompose
    // parent's forward jobs (code/review/test/fix) stay queued until every
    // `kind='decomposes'` child is satisfied — `merged_at` stamped OR `closed`
    // (same satisfaction rule as `blockedBy` above; the `closed` arm covers
    // skill-driven-merge projects that never stamp `merged_at`).
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
        AND c2.merged_at IS NULL
        AND c2.status <> 'closed'
    )`,
  };

  return { ctes, predicates };
}

// ISS-232 Phase 3 — `resolveProjectCap` is gone. The cap is hardcoded to
// `DEFAULT_MAX_CONCURRENT_ISSUES` (= 1) for every project; the
// `pipelineConfig.maxConcurrentIssues` knob was removed because the v2
// spec's primary-pinned + serial-per-project invariants require it.
// Operators who genuinely need higher parallelism run separate projects.

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
export async function pickNextDispatchableJobForProject(projectId: string): Promise<JobRow | null> {
  const cap = DEFAULT_MAX_CONCURRENT_ISSUES;
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const { ctes, predicates } = buildBarrierFragments({
    projectIdRef: sql`${projectId}`,
    livenessSeconds,
  });

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
      -- ISS-197 — L1 cooldown gate. retry_after_at is set by the retry
      -- engine when honouring a provider Retry-After hint; until the
      -- timestamp passes, the job is invisible to the picker.
      AND (j.retry_after_at IS NULL OR j.retry_after_at <= now())
      AND NOT (${predicates.issueBusySession})
      AND NOT (${predicates.issueBusyJob})
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
export async function assertDispatchable(jobId: string): Promise<DispatchBarrier> {
  const [job] = await db
    .select({ projectId: jobs.projectId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) return { ok: false, reason: 'not_found', hint: jobId };

  const cap = DEFAULT_MAX_CONCURRENT_ISSUES;
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const { ctes, predicates } = buildBarrierFragments({
    projectIdRef: sql`${job.projectId}`,
    livenessSeconds,
  });

  const rows = await db.execute<{ reason: string | null }>(sql`
    WITH ${ctes}
    SELECT
      CASE
        WHEN j.status <> 'queued' THEN 'not_queued'
        WHEN r.status <> 'running' THEN 'pipeline_run_not_running'
        WHEN j.retry_after_at IS NOT NULL AND j.retry_after_at > now() THEN 'retry_cooldown'
        WHEN ${predicates.issueBusySession} THEN 'issue_busy'
        WHEN ${predicates.issueBusyJob} THEN 'issue_busy'
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
      END AS reason
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
