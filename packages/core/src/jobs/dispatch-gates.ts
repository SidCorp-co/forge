/**
 * ISS-40 PR-E — dispatcher 4-layer gating helpers.
 *
 * Each gate is an independent boolean check. The dispatcher (and the
 * project-level re-tick orchestrator) call them in sequence; the first
 * failing gate decides the skip reason and short-circuits the dispatch.
 *
 *   L1 issue_busy     — at most one active session per issue
 *                       (also short-circuits on `issues.manual_hold = true`,
 *                        skip-reason 'manual_hold')
 *   L2 waiting_on_dep — every `kind='blocks'` parent must be terminal
 *   L3 project_full   — DISTINCT running issue_ids per project < cap
 *   L4 runner_full    — in-flight jobs on the chosen runner < runner cap
 *
 * Jobs skipped by a gate stay `jobs.status='queued'` and `agent_sessions.
 * status='queued'`. The gate reason is recorded on `jobs.gate_reason` +
 * `jobs.gate_at` (via markJobGated) so the queued-watchdog can distinguish
 * "queued because dispatcher is actively gating" from "queued because
 * pg-boss desync".
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs, projects, runners } from '../db/schema.js';
import type { JobType, RunnerType } from '../db/schema.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import {
  DECOMP_PARENT_RELEASED_STATUSES,
  findDecompositionParent,
} from '../pipeline/decomposition.js';
import { RUNNER_CAPABILITIES } from '../pipeline/registry.js';

export type GateSkipReason =
  | 'issue_busy'
  | 'manual_hold'
  | 'waiting_on_dep'
  | 'waiting_on_decomp_parent'
  | 'project_full'
  | 'runner_full';

export type GateResult =
  | { pass: true }
  | { pass: false; reason: GateSkipReason; hint?: string; metadata?: Record<string, unknown> };

const PASS: GateResult = { pass: true };

/** Issue statuses considered "done" for Layer 2 dependency satisfaction. */
const TERMINAL_ISSUE_STATUSES = ['released', 'closed', 'pipeline_failed'] as const;

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
 * L1 — at most one active session/job per issue. Returns `pass=false` when
 * another agent_sessions row (`queued|running`) exists for the same issueId,
 * OR another job row (`dispatched|running`) is alive for the same issueId.
 *
 * `excludeJobId` excludes the candidate job from the jobs check;
 * `excludeSessionId` excludes the candidate's own pipeline session from the
 * sessions check (the pipeline pre-creates the session at status-transition
 * time, so by the time the job dispatches, the session row already exists
 * and would otherwise self-trip the gate).
 */
export async function checkLayer1IssueBusy(
  issueId: string,
  options?: { excludeJobId?: string; excludeSessionId?: string },
): Promise<GateResult> {
  if (!issueId) return PASS;

  // ISS-42 C1 — manual hold short-circuit. We check this BEFORE the busy
  // check because the user-visible reason is more informative ("paused" beats
  // "another session active"). A user who sets manual_hold while a job is in
  // flight will not stop the in-flight job; they'll just block follow-ups.
  const [holdRow] = await db
    .select({ manualHold: issues.manualHold })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (holdRow?.manualHold) {
    return {
      pass: false,
      reason: 'manual_hold',
      hint: 'issue is on manual hold; toggle off to resume automation',
    };
  }

  // Active session for the same issue (issueId lives in metadata).
  const sessionRows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM agent_sessions
    WHERE status IN ('queued', 'running')
      AND (metadata->>'issueId') = ${issueId}
      ${options?.excludeSessionId ? sql`AND id <> ${options.excludeSessionId}` : sql``}
  `);
  const sessionCount = Number(sessionRows[0]?.count ?? '0');

  // Active jobs for the same issue (excluding the candidate). The
  // jobs_active_unique partial index already rejects duplicate (issueId,type)
  // queued+up rows, but a different job-type for the same issue can still
  // race; treat that as busy too.
  const conds = [
    eq(jobs.issueId, issueId),
    sql`${jobs.status} IN ('dispatched','running')`,
  ];
  if (options?.excludeJobId) {
    conds.push(sql`${jobs.id} <> ${options.excludeJobId}`);
  }
  const activeJobs = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(...conds))
    .limit(1);

  if (sessionCount > 0 || activeJobs.length > 0) {
    return {
      pass: false,
      reason: 'issue_busy',
      hint: 'another session for this issue is already active',
    };
  }
  return PASS;
}

interface BlockingParent {
  issueId: string;
  issSeq: number;
  status: string;
}

/**
 * L2 — every `kind='blocks'` parent must be in a terminal status. Cross-project
 * edges are honored. `valid_until` in the past is ignored.
 *
 * For `release`-type candidate jobs, also enforces the decomposition
 * release gate (ISS-119): a child of a `kind='decomposes'` parent stays
 * gated with `waiting_on_decomp_parent` until the parent reaches
 * `released` or `closed`, so children release atomically with the epic.
 *
 * On failure, `metadata.waitingOn` carries the list of parents so the sidebar
 * can render `Waiting for ISS-12, ISS-15 to finish`.
 */
export async function checkLayer2Dependencies(
  issueId: string,
  jobType?: JobType,
): Promise<GateResult> {
  if (!issueId) return PASS;
  const rows = await db.execute<{
    from_issue_id: string;
    iss_seq: number;
    status: string;
  }>(sql`
    SELECT i.id AS from_issue_id, i.iss_seq, i.status
    FROM issue_dependencies d
    JOIN issues i ON i.id = d.from_issue_id
    WHERE d.to_issue_id = ${issueId}
      AND d.kind = 'blocks'
      AND (d.valid_until IS NULL OR d.valid_until > now())
  `);
  const blocking: BlockingParent[] = [];
  for (const r of rows) {
    if (!(TERMINAL_ISSUE_STATUSES as readonly string[]).includes(r.status)) {
      blocking.push({ issueId: r.from_issue_id, issSeq: r.iss_seq, status: r.status });
    }
  }
  if (blocking.length > 0) {
    return {
      pass: false,
      reason: 'waiting_on_dep',
      hint: `waiting on ${blocking.length} blocking issue(s)`,
      metadata: { waitingOn: blocking },
    };
  }

  // ISS-119 — decomposition release gate. Only the `release` jobType is
  // gated; everything else for the child (code/review/test/staging) runs
  // independently of the epic's progress. `closed` parents count as
  // released so an abandoned epic never strands a finished child.
  if (jobType === 'release') {
    const parent = await findDecompositionParent(issueId);
    if (parent && !DECOMP_PARENT_RELEASED_STATUSES.has(parent.status)) {
      return {
        pass: false,
        reason: 'waiting_on_decomp_parent',
        hint: `decomposition parent ISS-${parent.issSeq} not released yet`,
        metadata: {
          parentId: parent.id,
          parentIssSeq: parent.issSeq,
          parentStatus: parent.status,
        },
      };
    }
  }

  return PASS;
}

/**
 * L3 — DISTINCT running issueIds in the project < project cap. The candidate's
 * own issue is excluded from the count: if it's already running, Layer 1
 * would have caught it, so reaching L3 means the candidate is not yet
 * counted toward `running`.
 */
export async function checkLayer3ProjectFull(
  projectId: string,
  candidateIssueId?: string | null,
): Promise<GateResult> {
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

  const rows = await db.execute<{ issue_id: string }>(sql`
    SELECT DISTINCT (metadata->>'issueId') AS issue_id
    FROM agent_sessions
    WHERE project_id = ${projectId}
      AND status IN ('queued', 'running')
      AND (metadata->>'issueId') IS NOT NULL
  `);
  const distinctIds = rows.map((r) => r.issue_id).filter((v): v is string => Boolean(v));
  // Don't count the candidate's own issue — the question is "are there
  // already `cap` OTHER issues running before me?".
  const others = candidateIssueId
    ? distinctIds.filter((id) => id !== candidateIssueId)
    : distinctIds;
  if (others.length >= cap) {
    return {
      pass: false,
      reason: 'project_full',
      hint: `project running ${others.length}/${cap} concurrent issues`,
      metadata: { cap, running: others.length },
    };
  }
  return PASS;
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
 * L4 — in-flight jobs on the chosen runner < runner cap. `excludeJobId` lets
 * the caller skip the candidate job (e.g. when re-checking after a transient
 * skip-and-requeue).
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
 * Pick the next queued job that is BOTH dependency-satisfied (Layer 2 met)
 * and not already covered by another active job for the same (issue,type).
 *
 * Ordering: priority DESC (critical>high>medium>low>none>null), then
 * the parent `pipeline_run.started_at ASC` (run cohesion — ISS-101), then
 * `queued_at ASC` as a final tiebreaker. Same-priority tier: every job of
 * the oldest run drains before a newer run's first job gets dispatched.
 * Higher priority on a newer run still preempts because the priority key
 * is applied before the run-age key.
 *
 * Closed/cancelled runs are filtered via `r.status = 'running'` — defence
 * in depth on top of the terminal-issue cascade that already moves jobs
 * out of `queued`.
 */
export async function pickNextDispatchableJobForProject(
  projectId: string,
): Promise<JobRow | null> {
  const rows = await db.execute<JobRow>(sql`
    SELECT j.*
    FROM jobs j
    LEFT JOIN issues i ON i.id = j.issue_id
    JOIN pipeline_runs r ON r.id = j.pipeline_run_id
    WHERE j.project_id = ${projectId}
      AND j.status = 'queued'
      AND j.type <> 'pm'
      AND r.status = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM issue_dependencies d
        JOIN issues p ON p.id = d.from_issue_id
        WHERE d.to_issue_id = j.issue_id
          AND d.kind = 'blocks'
          AND (d.valid_until IS NULL OR d.valid_until > now())
          AND p.status NOT IN ('released','closed','pipeline_failed')
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
 * Record a gate skip on the job row. Always runs (the job always exists at
 * gate-decision time, unlike the lazily-created agent_session). The
 * queued-watchdog reads `gate_at` to distinguish active gating from a dead
 * queue (pg-boss desync). Never throws — observability writes must not
 * break dispatch.
 */
export async function markJobGated(
  jobId: string,
  reason: GateSkipReason,
  hint?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db
      .update(jobs)
      .set({
        gateReason: reason,
        gateAt: new Date(),
        gateMetadata: (metadata ?? null) as never,
      })
      .where(eq(jobs.id, jobId));
    if (hint) {
      logger.debug({ jobId, reason, hint }, 'dispatch-gates: skip');
    }
    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'dispatch.gated',
        level: 'info',
        message: `gated: ${reason}`,
        data: { jobId, reason, hint },
      });
    }
  } catch (err) {
    logger.warn({ err, jobId, reason }, 'dispatch-gates: markJobGated failed');
  }
}
