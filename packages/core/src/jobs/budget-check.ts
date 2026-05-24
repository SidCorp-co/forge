/**
 * W2.3.2 — Pre-dispatch monthly budget gate.
 *
 * Reads the configured `perMonthUsd` cap for the issue's `stageStatus`
 * (via the same overrides resolver the dispatcher already uses for prompt /
 * model / tooling overrides), sums month-to-date `cost_usd` for the same
 * (project, jobType) pair from the `pipeline_run_step_durations` view, and
 * decides whether to:
 *   - allow:    spend below the warn threshold
 *   - warn-80:  spend ≥ 80% of cap (or ≥ 100% under action='warn')
 *   - pause:    spend ≥ 100% of cap AND action='pause' → fail the job
 *
 * Fail-open posture: any DB error returns `allow` so a budget-check outage
 * cannot stall the pipeline. Mirrors `loadStageMap` in stage-overrides.ts.
 *
 * Idempotency for warn emissions is provided by `shouldEmitWarn` — an
 * in-process Map keyed by `(projectId, stageStatus, hourBucket)`. Multi-
 * replica deployments may emit one warn per replica per hour; acceptable
 * for v1, promote to a DB-backed dedup in W2.3.4 if needed.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues, type jobs, projects } from '../db/schema.js';
import type { JobType } from '../db/schema.js';
import { logger } from '../logger.js';
import { extractStageStatus, resolveStageOverrides } from './stage-overrides.js';

export interface BudgetCheckResult {
  action: 'allow' | 'warn-80' | 'pause';
  /** Current month spend on (projectId, jobType), USD. 0 when not queried. */
  spent: number;
  /** Configured `perMonthUsd`, or null when no budget is configured. */
  budget: number | null;
  /** Resolved stage status from the job's payload (for telemetry / payloads). */
  stageStatus: string | null;
}

const ALLOW_NO_STAGE: BudgetCheckResult = {
  action: 'allow',
  spent: 0,
  budget: null,
  stageStatus: null,
};

/**
 * Compute the dispatch decision for a queued job.
 *
 * Short-circuits to `allow` when no `stageStatus` is stamped on the payload
 * (legacy jobs, PM jobs) or when the resolved stage has no `perMonthUsd`.
 */
export async function checkMonthlyBudget(
  job: typeof jobs.$inferSelect,
): Promise<BudgetCheckResult> {
  const stageStatus = extractStageStatus(job.payload);
  if (!stageStatus) return ALLOW_NO_STAGE;

  const overrides = await resolveStageOverrides(job.projectId, job.payload);
  const budget = overrides.budget?.perMonthUsd;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    return { action: 'allow', spent: 0, budget: null, stageStatus };
  }
  // Default to 'pause' when a `perMonthUsd` is set without an explicit
  // `action` — matches the issue's stated safety intent ("the actual safety
  // net … without it, a runaway pipeline burns full month-budget").
  const mode: 'warn' | 'pause' = overrides.budget?.action ?? 'pause';

  let spent = 0;
  try {
    const rows = (await db.execute(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::float AS spent
      FROM pipeline_run_step_durations
      WHERE project_id = ${job.projectId}
        AND step = ${job.type}
        AND started_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
    `)) as unknown as Array<{ spent: number | string | null }>;
    const raw = rows?.[0]?.spent ?? 0;
    spent = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
    if (!Number.isFinite(spent)) spent = 0;
  } catch (err) {
    logger.warn(
      { err, projectId: job.projectId, jobType: job.type, stageStatus },
      'budget-check: SUM query failed, dispatching with allow (fail-open)',
    );
    return { action: 'allow', spent: 0, budget, stageStatus };
  }

  if (spent >= budget && mode === 'pause') {
    return { action: 'pause', spent, budget, stageStatus };
  }
  if (spent >= 0.8 * budget) {
    return { action: 'warn-80', spent, budget, stageStatus };
  }
  return { action: 'allow', spent, budget, stageStatus };
}

// --- warn dedup --------------------------------------------------------

// Key = `${projectId}:${stageStatus}:${hourBucket}`. Cap size at 1024 to
// bound memory; on overflow drop the oldest half (cheap, no LRU bookkeeping
// — at 1024 stages × 1 hour buckets we'd already be far past any realistic
// load anyway).
const warnDedup = new Map<string, number>();

export function shouldEmitWarn(projectId: string, stageStatus: string): boolean {
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const key = `${projectId}:${stageStatus}:${hourBucket}`;
  if (warnDedup.has(key)) return false;
  warnDedup.set(key, Date.now());
  if (warnDedup.size > 1024) {
    const it = warnDedup.keys();
    for (let i = 0; i < 512; i++) {
      const next = it.next();
      if (next.done) break;
      warnDedup.delete(next.value);
    }
  }
  return true;
}

/** Test-only: clear the in-process warn-dedup map between unit tests. */
export function __resetBudgetWarnDedup(): void {
  warnDedup.clear();
}

// --- breach comment ----------------------------------------------------

export interface PostBudgetExhaustedCommentInput {
  issueId: string;
  jobType: JobType;
  result: BudgetCheckResult;
}

/**
 * Post the operator-facing comment that explains a dispatch was blocked
 * by the monthly budget cap. Authored by the project owner so the comment
 * carries a real author_id (issue-level comments are not nullable on that
 * column). No-op if the issue (or its project owner) cannot be resolved.
 */
export async function postBudgetExhaustedComment(
  input: PostBudgetExhaustedCommentInput,
): Promise<void> {
  const [row] = await db
    .select({ ownerId: projects.ownerId })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, input.issueId))
    .limit(1);
  if (!row?.ownerId) return;

  const budgetStr =
    typeof input.result.budget === 'number' ? `$${input.result.budget.toFixed(2)}` : 'n/a';
  const body = [
    '🚫 **Budget cap reached** — job dispatch blocked.',
    '',
    `**Stage:** \`${input.result.stageStatus ?? 'unknown'}\` (job type \`${input.jobType}\`)`,
    `**Spent this month:** $${input.result.spent.toFixed(2)} of ${budgetStr} cap`,
    '',
    "Increase the per-month budget on the project's pipeline config to unblock, or wait for the next month boundary.",
  ].join('\n');

  try {
    await db.insert(comments).values({
      issueId: input.issueId,
      authorId: row.ownerId,
      body,
      isAi: true,
    } as never);
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId },
      'budget-check: failed to post exhausted comment, continuing',
    );
  }
}
