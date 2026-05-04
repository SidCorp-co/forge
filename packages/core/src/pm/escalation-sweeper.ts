/**
 * PM escalation fallback sweeper (Epic 5, ISS-21).
 *
 * Every 5 minutes, find `pm_decisions` rows whose `actions` contain an
 * `escalate` entry, whose `event_ref.expiresAt` is in the past, and which
 * have no follow-up decision (either `operator-reply` or
 * `escalation-timeout` referencing this row as `parentDecisionId`).
 *
 * For each, walk the `actions` array, locate the `escalate` entries, and
 * execute their PM-authored `fallback` action as a system actor (project
 * owner). Record the outcome as a new `pm_decisions` row with
 * `cause='escalation-timeout'` so a re-run sees the row as followed up
 * (NOT EXISTS guard) and skips it.
 *
 * v1 supports `fallback.type === 'dispatch'` only. Other writer-tool
 * types (`set_dependency`, `flag_blocker`, `comment`) are out of scope
 * here — they are recorded as `skipped` so the parent decision is still
 * marked followed-up and a noisy escalation does not loop forever. The
 * memory indexer fires off the new decision row via the
 * `forge_pm.write_decision` codepath (we go direct here because the
 * sweeper is a system actor without a device principal).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, pmDecisions, projects } from '../db/schema.js';
import { enqueueJob } from '../jobs/enqueue.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { indexMemory } from '../memory/indexer.js';
import { Sentry } from '../observability/sentry.js';
import { boss } from '../queue/boss.js';

export const PM_ESCALATION_SWEEPER_QUEUE = 'pm.escalation-sweeper';
const PM_ESCALATION_SWEEPER_CRON = '*/5 * * * *';
const SWEEP_BATCH_LIMIT = 50;

interface ExpiredEscalationRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  event_ref: Record<string, unknown> | null;
  actions: unknown[] | null;
}

interface FallbackAction {
  type: string;
  [key: string]: unknown;
}

export interface PmEscalationSweepResult {
  examined: number;
  executed: number;
  skipped: number;
  errors: number;
}

/**
 * Run one escalation sweep. Pure function over the DB — no scheduling
 * side effects, so tests and the cron worker share the same code path.
 */
export async function runPmEscalationSweep(
  now: Date = new Date(),
): Promise<PmEscalationSweepResult> {
  const expired = await selectExpiredEscalations(now);
  let executed = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of expired) {
    try {
      const fallbacks = collectFallbacks(row.actions);
      if (fallbacks.length === 0) {
        skipped++;
        await recordTimeout(row, { skipped: true, reason: 'no_fallback' });
        continue;
      }
      let anyExecuted = false;
      const outcomes: Array<{ type: string; status: 'executed' | 'skipped'; reason?: string }> = [];
      for (const fb of fallbacks) {
        const result = await executeFallback(row.project_id, fb);
        outcomes.push({ type: fb.type, ...result });
        if (result.status === 'executed') anyExecuted = true;
      }
      await recordTimeout(row, { skipped: !anyExecuted, outcomes });
      if (anyExecuted) executed++;
      else skipped++;
    } catch (err) {
      errors++;
      logger.error(
        { err, decisionId: row.id, projectId: row.project_id },
        'pm-escalation-sweeper: per-decision handler threw',
      );
      try {
        Sentry.captureException(err, { tags: { sweeper: 'pm-escalation' } });
      } catch {
        // Sentry no-op when not initialised — never let the swallow throw.
      }
    }
  }

  return { examined: expired.length, executed, skipped, errors };
}

async function selectExpiredEscalations(now: Date): Promise<ExpiredEscalationRow[]> {
  const result = await db.execute<ExpiredEscalationRow>(sql`
    SELECT d.id, d.project_id, d.event_ref, d.actions
    FROM ${pmDecisions} d
    WHERE d.actions @> '[{"type":"escalate"}]'::jsonb
      AND (d.event_ref->>'expiresAt')::timestamptz < ${now.toISOString()}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM ${pmDecisions} f
        WHERE f.project_id = d.project_id
          AND f.event_ref->>'parentDecisionId' = d.id::text
          AND f.cause IN ('operator-reply', 'escalation-timeout')
      )
    LIMIT ${SWEEP_BATCH_LIMIT}
  `);
  // drizzle's db.execute shape varies across drivers — match queue-pressure.ts
  return Array.isArray(result)
    ? (result as ExpiredEscalationRow[])
    : ((result as { rows?: ExpiredEscalationRow[] }).rows ?? []);
}

function collectFallbacks(actions: unknown[] | null): FallbackAction[] {
  if (!Array.isArray(actions)) return [];
  const out: FallbackAction[] = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const action = a as { type?: unknown; fallback?: unknown };
    if (action.type !== 'escalate') continue;
    const fb = action.fallback;
    if (!fb || typeof fb !== 'object') continue;
    const fbAction = fb as { type?: unknown };
    if (typeof fbAction.type !== 'string') continue;
    out.push(fb as FallbackAction);
  }
  return out;
}

async function executeFallback(
  projectId: string,
  fallback: FallbackAction,
): Promise<{ status: 'executed' | 'skipped'; reason?: string }> {
  // Depth=1 cap: PM cannot escalate-on-escalate.
  if (fallback.type === 'escalate') {
    logger.warn({ projectId }, 'pm-escalation-sweeper: nested escalate fallback rejected');
    return { status: 'skipped', reason: 'nested_escalate' };
  }
  if (fallback.type !== 'dispatch') {
    // Out of v1 scope — record skip so the parent escalation is still
    // marked followed-up and we don't loop on the same row every 5 min.
    logger.info(
      { projectId, type: fallback.type },
      'pm-escalation-sweeper: fallback type not yet supported',
    );
    return { status: 'skipped', reason: 'unsupported_type' };
  }
  return executeDispatchFallback(projectId, fallback);
}

async function executeDispatchFallback(
  projectId: string,
  fallback: FallbackAction,
): Promise<{ status: 'executed' | 'skipped'; reason?: string }> {
  const issueId = typeof fallback.issueId === 'string' ? fallback.issueId : null;
  const jobType = typeof fallback.jobType === 'string' ? fallback.jobType : null;
  if (!issueId || !jobType) {
    return { status: 'skipped', reason: 'invalid_dispatch_payload' };
  }

  const ownerId = await loadProjectOwner(projectId);
  if (!ownerId) return { status: 'skipped', reason: 'project_missing' };

  const userPayload =
    fallback.payload && typeof fallback.payload === 'object' ? fallback.payload : {};
  // Mirror forge_pm.dispatch payload shape so the runner sees an identical
  // job whether it came from the live PM agent or the timeout sweeper.
  const payload: Record<string, unknown> = {
    ...(userPayload as Record<string, unknown>),
    skillName: `forge-${jobType}`,
    dispatchedBy: 'pm-escalation-timeout',
    reason: 'PM escalation expired; running PM-authored fallback action',
  };

  let insertedId: string | null = null;
  try {
    const [inserted] = await db
      .insert(jobs)
      .values({
        projectId,
        issueId,
        createdBy: ownerId,
        type: jobType as never,
        payload,
        status: 'queued',
      } as never)
      .returning({ id: jobs.id });
    insertedId = inserted?.id ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Active dispatch of the same type already exists — treat as success
      // for idempotency. No new job needed.
      return { status: 'executed', reason: 'already_active' };
    }
    throw err;
  }
  if (!insertedId) return { status: 'skipped', reason: 'insert_returned_no_row' };

  try {
    await enqueueJob(insertedId);
  } catch (err) {
    logger.error(
      { err, jobId: insertedId },
      'pm-escalation-sweeper: pg-boss enqueue failed; row persisted',
    );
  }
  return { status: 'executed' };
}

async function loadProjectOwner(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(sql`${projects.id} = ${projectId}`)
    .limit(1);
  return row?.ownerId ?? null;
}

async function recordTimeout(
  parent: ExpiredEscalationRow,
  detail: {
    skipped: boolean;
    reason?: string;
    outcomes?: Array<{ type: string; status: string; reason?: string }>;
  },
): Promise<void> {
  const summary = detail.skipped
    ? `Escalation expired; no fallback executed (${detail.reason ?? 'unsupported'})`
    : 'Escalation expired; PM-authored fallback executed by sweeper';
  const eventRef: Record<string, unknown> = {
    parentDecisionId: parent.id,
    fallbackOutcomes: detail.outcomes ?? [],
  };

  const [inserted] = await db
    .insert(pmDecisions)
    .values({
      projectId: parent.project_id,
      sessionId: null,
      cause: 'escalation-timeout',
      eventRef,
      summary,
      actions: [],
    })
    .returning({ id: pmDecisions.id });
  if (!inserted) return;

  // Mirror forge_pm.write_decision: detached memory index so embed latency
  // doesn't block the sweeper tick.
  const decisionId = inserted.id;
  queueMicrotask(() => {
    indexMemory({
      projectId: parent.project_id,
      source: 'decision',
      sourceRef: decisionId,
      text: summary,
      metadata: { cause: 'escalation-timeout', parentDecisionId: parent.id },
    }).catch((err) => {
      logger.error(
        { err: (err as Error).message, decisionId, parentDecisionId: parent.id },
        'pm-escalation-sweeper: detached indexer failed',
      );
    });
  });
}

let registered = false;

export async function registerPmEscalationSweeper(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(PM_ESCALATION_SWEEPER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(PM_ESCALATION_SWEEPER_QUEUE, async () => {
    try {
      const result = await runPmEscalationSweep();
      if (result.executed > 0 || result.errors > 0) {
        logger.info(result, 'pm-escalation-sweeper: actioned');
      }
    } catch (err) {
      logger.error({ err }, 'pm-escalation-sweeper: tick failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(PM_ESCALATION_SWEEPER_QUEUE, PM_ESCALATION_SWEEPER_CRON, {});
  registered = true;
}

export async function unregisterPmEscalationSweeper(): Promise<void> {
  if (!registered) return;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
    await (boss as any).unschedule?.(PM_ESCALATION_SWEEPER_QUEUE);
  } catch {
    // unschedule is best-effort — if the schedule never existed, ignore.
  }
  registered = false;
}

export function resetPmEscalationSweeperForTest(): void {
  registered = false;
}
