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
 * (manualHold, blocked_by, project_cap, runner_full, retry_cooldown,
 * pipeline_run_running) instead of just L1 issue_busy.
 *
 * Gate layers (single-source, see {@link buildBarrierFragments}):
 *   L1 issue_busy / manual_hold — at most one active session per issue;
 *                                 `issues.manual_hold = true` excludes
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

import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, projects, runners } from '../db/schema.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { RUNNER_CAPABILITIES } from '../pipeline/registry.js';

export type GateSkipReason =
  | 'not_found'
  | 'not_queued'
  | 'pipeline_run_not_running'
  | 'manual_hold'
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
export type DispatchBarrier =
  | { ok: true }
  | { ok: false; reason: GateSkipReason; hint?: string };

const PASS: GateResult = { pass: true };

/** Default per-project cap when `agent_config.pipelineConfig.maxConcurrentIssues`
 *  is unset. Set to 1 so multiple in-flight code/fix sessions on the same repo
 *  cannot race each other into merge conflicts — the dominant failure mode
 *  observed when the cap defaulted to 3 (forge-code + forge-fix branching off
 *  the same base, then colliding on the same files at release time). Operators
 *  with isolated worktrees per session can opt back into higher parallelism by
 *  setting `pipelineConfig.maxConcurrentIssues` explicitly on the project. */
export const DEFAULT_MAX_CONCURRENT_ISSUES = 1;

/** Default per-runner cap when `runners.capabilities.maxConcurrent` is unset. */
const RUNNER_DEFAULT_CONCURRENCY: Record<string, number> = {
  // Desktop Tauri runner spawns Claude CLI processes serially in practice;
  // cap=1 reflects measured throughput. Operators can override via
  // runners.capabilities.maxConcurrent if their environment supports parallel.
  'claude-code': 1,
  antigravity: 5,
};
const RUNNER_DEFAULT_FALLBACK = 1;

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
 * mirrors the FULL picker gate set (manual_hold, blocked_by, project_cap,
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
 */
export async function countInFlightForRunner(runnerId: string): Promise<number> {
  const rows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM jobs
    WHERE runner_id = ${runnerId}
      AND status IN ('dispatched', 'running')
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
    .select({ type: runners.type, capabilities: runners.capabilities })
    .from(runners)
    .where(eq(runners.id, runnerId))
    .limit(1);
  if (!runner) return PASS; // Runner vanished; let the dispatcher hit its own no-runner branch.

  const caps = (runner.capabilities ?? {}) as Record<string, unknown>;
  const cap =
    typeof caps.maxConcurrent === 'number' && caps.maxConcurrent > 0
      ? caps.maxConcurrent
      : (RUNNER_DEFAULT_CONCURRENCY[runner.type] ?? RUNNER_DEFAULT_FALLBACK);

  const rows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM jobs
    WHERE runner_id = ${runnerId}
      AND status IN ('dispatched', 'running')
      ${options?.excludeJobId ? sql`AND id <> ${options.excludeJobId}` : sql``}
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
    /** L2 — release jobs additionally wait for their `kind='decomposes'`
     *  parent to release/close. Self-gated on `j.type = 'release'`. */
    releaseDecomposePending: SQL;
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
 * the `retry_after_at` cooldown, the manual_hold pass form, and the
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

  // running_ids: every issue currently holding a slot, either via an
  // in-flight agent_session OR via a queued job sitting in retry cooldown.
  // Without the cooldown UNION, a worker-wide failure (session/usage limit,
  // provider 429 with a long Retry-After) would release the slot during the
  // cooldown window, letting unrelated issues dispatch and burn the same
  // limit. The L3 cap now treats "issue is retrying" as "issue is busy" —
  // strict per-cap serialization until the failing issue resolves or the
  // operator cancels it.
  const ctes = sql`running_ids AS (
      SELECT DISTINCT (metadata->>'issueId') AS issue_id
      FROM agent_sessions
      WHERE project_id = ${projectIdRef}
        AND status IN ('queued','running')
        AND (metadata->>'issueId') IS NOT NULL
      UNION
      SELECT DISTINCT issue_id::text
      FROM jobs
      WHERE project_id = ${projectIdRef}
        AND status = 'queued'
        AND retry_after_at IS NOT NULL
        AND retry_after_at > now()
        AND issue_id IS NOT NULL
    ),
    runner_load AS (
      SELECT runner_id, COUNT(*)::int AS in_flight
      FROM jobs
      WHERE runner_id IS NOT NULL
        AND status IN ('dispatched','running')
      GROUP BY runner_id
    ),
    fresh_capable_runners AS (
      SELECT r.id,
             COALESCE(
               (r.capabilities->>'maxConcurrent')::int,
               CASE r.type WHEN 'antigravity' THEN 5 ELSE 1 END
             ) AS cap,
             COALESCE(rl.in_flight, 0) AS in_flight
      FROM runners r
      LEFT JOIN runner_load rl ON rl.runner_id = r.id
      WHERE r.project_id = ${projectIdRef}
        AND r.status = 'online'
        AND r.last_seen_at IS NOT NULL
        AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
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
    // ISS-232 — Layer 2 is now git-aware. The previous status-based check
    // (parent in `released | closed`) treated a manually-closed-but-unmerged
    // parent as "satisfied" and let dependent children dispatch even though
    // the parent's branch wasn't on origin. Switching to `parent.merged_at
    // IS NULL` defers to the state-machine writer (see
    // `issues/merged-at.ts:markMergedIfLeavingBase`) which stamps
    // `merged_at` only on transitions out of `pipelineConfig.mergeStates
    // .baseBranch`. Operator manual override is a direct
    // `UPDATE issues SET merged_at = now() WHERE id = …`.
    blockedBy: sql`j.type <> 'pm' AND EXISTS (
      SELECT 1 FROM issue_dependencies d
      JOIN issues p ON p.id = d.from_issue_id
      WHERE d.to_issue_id = j.issue_id
        AND d.kind = 'blocks'
        AND (d.valid_until IS NULL OR d.valid_until > now())
        AND p.merged_at IS NULL
    )`,
    releaseDecomposePending: sql`j.type = 'release' AND EXISTS (
      SELECT 1 FROM issue_dependencies d2
      JOIN issues p2 ON p2.id = d2.from_issue_id
      WHERE d2.to_issue_id = j.issue_id
        AND d2.kind = 'decomposes'
        AND (d2.valid_until IS NULL OR d2.valid_until > now())
        AND p2.merged_at IS NULL
    )`,
  };

  return { ctes, predicates };
}

async function resolveProjectCap(projectId: string): Promise<number> {
  const [project] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const agentConfig = (project?.agentConfig ?? {}) as Record<string, unknown>;
  const pipelineConfig = (agentConfig.pipelineConfig ?? {}) as Record<string, unknown>;
  return typeof pipelineConfig.maxConcurrentIssues === 'number' &&
    pipelineConfig.maxConcurrentIssues > 0
    ? pipelineConfig.maxConcurrentIssues
    : DEFAULT_MAX_CONCURRENT_ISSUES;
}

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
export async function pickNextDispatchableJobForProject(
  projectId: string,
): Promise<JobRow | null> {
  const cap = await resolveProjectCap(projectId);
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
      AND (i.id IS NULL OR i.manual_hold IS NOT TRUE)
      AND NOT (${predicates.issueBusySession})
      AND NOT (${predicates.issueBusyJob})
      AND NOT (${predicates.blockedBy})
      AND NOT (${predicates.releaseDecomposePending})
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

  const cap = await resolveProjectCap(job.projectId);
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
        WHEN i.id IS NOT NULL AND i.manual_hold IS TRUE THEN 'manual_hold'
        WHEN j.retry_after_at IS NOT NULL AND j.retry_after_at > now() THEN 'retry_cooldown'
        WHEN ${predicates.issueBusySession} THEN 'issue_busy'
        WHEN ${predicates.issueBusyJob} THEN 'issue_busy'
        WHEN ${predicates.blockedBy} THEN 'blocked_by'
        WHEN ${predicates.releaseDecomposePending} THEN 'release_decompose_pending'
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
