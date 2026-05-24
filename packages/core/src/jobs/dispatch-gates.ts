/**
 * ISS-162 — Stateless Gates. `pickNextDispatchableJobForProject` evaluates
 * the gate layers inline on every call; no gate signal is persisted on
 * the job row. A job that fails any gate is simply absent from the SELECT
 * result, and the next tick recomputes the gate from scratch.
 *
 *   L1 issue_busy / manual_hold — at most one active session per issue;
 *                                  `issues.manual_hold = true` excludes
 *   L2 waiting_on_dep / decomp  — every `kind='blocks'` parent must be
 *                                  terminal; release jobs additionally wait
 *                                  for their `kind='decomposes'` parent
 *   L3 project_full              — DISTINCT running issue_ids per project
 *                                  must be below the project cap (or the
 *                                  candidate's own issue is already counted)
 *   L5 runner_heartbeat (pre-pick) — runner selection filters runners whose
 *                                  `last_seen_at` falls outside the dispatch
 *                                  liveness window (default 30s, ISS-198).
 *                                  Implemented in `runners/select.ts`; the
 *                                  helper {@link checkLayer5RunnerHeartbeat}
 *                                  exposes the same predicate for tests +
 *                                  telemetry.
 *
 * L4 (runner capacity) used to live post-pick inside the dispatcher. ISS-198
 * folded the check into the picker SQL so a runner that just hit its cap no
 * longer wastes a tick — the picker simply refuses to surface a job whose
 * only candidate runner is full. {@link checkLayer4RunnerFull} is retained
 * as a defence-in-depth helper for telemetry; the dispatcher itself no
 * longer calls it.
 *
 * Invariants:
 *   - No temporal predicates beyond dependency-edge `valid_until` expiry,
 *     stale-runner heartbeat (L5) and runner-load (L4). A future
 *     contributor adding a `gate_at + N seconds` debouncer should trip the
 *     regression assertion in `dispatch-gates.test.ts`.
 *   - No writes from the picker. The hot path is read-only.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, projects, runners } from '../db/schema.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { RUNNER_CAPABILITIES } from '../pipeline/registry.js';

export type GateSkipReason = 'runner_full' | 'runner_stale';

export type GateResult =
  | { pass: true }
  | { pass: false; reason: GateSkipReason; hint?: string; metadata?: Record<string, unknown> };

const PASS: GateResult = { pass: true };

/** Default per-project cap when `agent_config.pipelineConfig.maxConcurrentIssues` is unset. */
export const DEFAULT_MAX_CONCURRENT_ISSUES = 3;

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

/**
 * Pick the next queued job that satisfies L1/L2/L3 inline, or null if no such
 * job exists. L4 (runner_full) is evaluated post-pick by the dispatcher
 * because runner selection happens after pick.
 *
 * Ordering: priority DESC (critical>high>medium>low>none>null), then the
 * parent `pipeline_run.started_at ASC` (run cohesion — ISS-101), then
 * `queued_at ASC` as a final tiebreaker. Same-priority tier: every job of
 * the oldest run drains before a newer run's first job gets dispatched.
 * Higher priority on a newer run still preempts because the priority key is
 * applied before the run-age key.
 *
 * Closed/cancelled runs are filtered via `r.status = 'running'` — defence
 * in depth on top of the terminal-issue cascade that already moves jobs out
 * of `queued`.
 */
export async function pickNextDispatchableJobForProject(
  projectId: string,
): Promise<JobRow | null> {
  // L3 cap comes from the project's pipelineConfig; resolve once per call so
  // the SELECT can pass it as a single parameter. Avoiding a JSON cast inside
  // the WHERE keeps the planner happy.
  const [project] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const agentConfig = (project?.agentConfig ?? {}) as Record<string, unknown>;
  const pipelineConfig = (agentConfig.pipelineConfig ?? {}) as Record<string, unknown>;
  const cap =
    typeof pipelineConfig.maxConcurrentIssues === 'number' && pipelineConfig.maxConcurrentIssues > 0
      ? pipelineConfig.maxConcurrentIssues
      : DEFAULT_MAX_CONCURRENT_ISSUES;

  // ISS-198 — L5 (heartbeat) + L4 (capacity) moved into the picker. A runner
  // must be online, must have pinged inside the dispatch-liveness window,
  // AND must have room for one more job. `runner_load` counts in-flight
  // jobs per runner; the per-row cap reads `capabilities.maxConcurrent`
  // with a type-aware default (antigravity=5, others=1). If no such runner
  // exists, no job for that project is returned this tick — saves the
  // wasted tick of returning a job only for dispatchViaRunner to skip it.
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const rows = await db.execute<JobRow>(sql`
    WITH running_ids AS (
      SELECT DISTINCT (metadata->>'issueId') AS issue_id
      FROM agent_sessions
      WHERE project_id = ${projectId}
        AND status IN ('queued','running')
        AND (metadata->>'issueId') IS NOT NULL
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
      WHERE r.project_id = ${projectId}
        AND r.status = 'online'
        AND r.last_seen_at IS NOT NULL
        AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
    )
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
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s
        WHERE s.status IN ('queued','running')
          AND (s.metadata->>'issueId') = j.issue_id::text
          AND (j.agent_session_id IS NULL OR s.id <> j.agent_session_id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs other
        WHERE other.issue_id = j.issue_id
          AND other.id <> j.id
          AND other.status IN ('dispatched','running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM issue_dependencies d
        JOIN issues p ON p.id = d.from_issue_id
        WHERE d.to_issue_id = j.issue_id
          AND d.kind = 'blocks'
          AND (d.valid_until IS NULL OR d.valid_until > now())
          AND p.status NOT IN ('released','closed')
      )
      AND NOT (
        j.type = 'release'
        AND EXISTS (
          SELECT 1 FROM issue_dependencies d2
          JOIN issues p2 ON p2.id = d2.from_issue_id
          WHERE d2.to_issue_id = j.issue_id
            AND d2.kind = 'decomposes'
            AND (d2.valid_until IS NULL OR d2.valid_until > now())
            AND p2.status NOT IN ('released','closed')
        )
      )
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
