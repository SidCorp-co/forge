import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus, JobType } from '../db/schema.js';
import { applyStatusTransition } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_INFLIGHT_STATUSES,
  AUTONOMOUS_JOB_TYPE,
} from './autonomous-mode.js';
import { checkAutonomousRescueCap, recordAutonomousRescue } from './autonomous-rescue-cap.js';
import { reEnqueueForIssue } from './orchestrator.js';

/**
 * ISS-196 — minute-cadence safety net for the trigger → outbox → orchestrator
 * path. Two responsibilities:
 *   1. Rescue issues stuck at an auto-dispatch status with no active job —
 *      happens when the worker crashed mid-dispatch on a row whose
 *      `pipeline_outbox.processed_at` was set just before `insertAndEnqueueJob`
 *      threw, or when the outbox row was processed but the orchestrator
 *      decided not to enqueue and the issue later became eligible again.
 *   2. Sentry-breadcrumb when the outbox itself has stale unprocessed rows
 *      (>5min) — signals worker death even when no issue is stuck yet.
 *
 * Should be rare: `reconciler_hits_per_hour > 0` means the happy path
 * (trigger + worker) missed an event. Grafana alarms on a non-zero rate
 * sustained over multiple buckets.
 */

const RECONCILER_QUEUE = 'pipeline-reconciler';
const STALE_OUTBOX_INTERVAL = '5 minutes';
const STUCK_ISSUE_INTERVAL = '60 seconds';
const STUCK_ISSUE_LIMIT = 100;

// cm:guard the ISS-598 in-flight wedge pass was deleted here by ISS-895, and re-adding one is re-adding the staged lane. It keyed on `PIPELINE_STEPS.workingStatus` — the code/fix trigger→working edge — and `drive` never had one. `resetAutonomousWedgesOnce` below is the net that covers this lane, and it is the only one; a second pass keyed on a step table would find nothing and report the same zero as a pass that is switched off.
const WEDGE_GRACE = '10 minutes';
const WEDGE_RESET_LIMIT = 50;

let registered = false;

/**
 * Did the re-enqueue actually produce a job? Same predicate as the stuck-issue
 * query's NOT EXISTS, so "rescued" and "stuck" can never disagree about what a
 * live job is.
 */
async function hasActiveJob(issueId: string): Promise<boolean> {
  const rows = await db.execute<{ one: number }>(sql`
    SELECT 1 AS one FROM jobs
    WHERE issue_id = ${issueId} AND status IN ('queued','dispatched','running')
    LIMIT 1
  `);
  return rows.length > 0;
}

export async function runReconcilerOnce(): Promise<{
  rescued: number;
  stale: number;
  autonomousReset: number;
}> {
  let rescued = 0;
  let stale = 0;
  let autonomousReset = 0;

  // cm:guard the entry status is the WHOLE rescue set now. This used to embed `AUTO_DISPATCH_STATUSES` — the nine `PIPELINE_STEPS` trigger statuses — and ISS-895 left one, so a stuck issue is by definition one sitting at `open` with nothing working it. Widening this back to the staged rungs would re-scan the statuses migration 0208 emptied, and `dispatchAutonomous` enqueues at the entry status only, so every row it found would be re-read every 60s and produce nothing.
  const stuck = await db.execute<{
    id: string;
    project_id: string;
    status: string;
    created_by: string | null;
    reopen_count: number;
  }>(sql`
    SELECT i.id, i.project_id, i.status, i.reopen_count, p.created_by
    FROM issues i
    INNER JOIN projects p ON p.id = i.project_id
    WHERE i.status = ${AUTONOMOUS_ENTRY_STATUS}
      AND i.updated_at < now() - interval '${sql.raw(STUCK_ISSUE_INTERVAL)}'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.issue_id = i.id
          AND j.status IN ('queued','dispatched','running')
      )
    LIMIT ${STUCK_ISSUE_LIMIT}
  `);

  for (const row of stuck) {
    try {
      // cm:guard this cap is the ONLY thing bounding re-dispatch on this path since ISS-895 removed the ISS-626 stage-stall guard, which counted `done` jobs of a stage's job type and could never see `drive` (it had no step entry, so the type it counted never existed). Removing this check restores an unbounded re-dispatch loop on every project — the ISS-626 incident with a different job type.
      const cap = await checkAutonomousRescueCap({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
        reopenCount: row.reopen_count,
      });
      if (cap.capped) continue;
      // cm:guard a null runId here is CORRECT, not a miss: on this path `openIssueRun` runs inside `dispatchAutonomous`, i.e. after the check, so a fresh issue has no run yet and its first rescue charges nothing. The loop this cap exists to bound starts at cycle two, where the run exists — charging cycle one would only shorten the allowance by one for every issue that ever entered normally.
      const autonomousRunId: string | null = cap.runId;

      const actorId = row.created_by ?? '<reconciler>';
      await reEnqueueForIssue({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
        // Synthesise a device principal from the project owner; matches the
        // pattern in orchestrator.resolveSkipDevice (no schema change needed).
        actor: { type: 'device', id: actorId, agency: 'agent' },
        reason: { reconciler: true, reason: 'enqueued_missing' },
      });

      // cm:guard count the OUTCOME, never the attempt. `considerEnqueue` has a dozen paths that enqueue nothing — a disabled stage, a human-gated one, a race, a missing skill — and an issue parked on any of them is re-read every 60s forever. Counting the attempt made that loop indistinguishable from productive work, and the breadcrumb fired every minute for it.
      if (!(await hasActiveJob(row.id))) continue;

      if (autonomousRunId) await recordAutonomousRescue(autonomousRunId);

      rescued++;
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.reconciler.enqueued_missing',
          level: 'warning',
          data: { issueId: row.id, status: row.status },
        });
      }
    } catch (err) {
      logger.error({ err, issueId: row.id, status: row.status }, 'reconciler: rescue failed');
    }
  }

  try {
    const staleRows = await db.execute<{ count: string | number }>(sql`
      SELECT COUNT(*)::text AS count
      FROM pipeline_outbox
      WHERE processed_at IS NULL
        AND created_at < now() - interval '${sql.raw(STALE_OUTBOX_INTERVAL)}'
    `);
    const first = staleRows[0];
    const n = first ? Number(first.count) : 0;
    if (n > 0) {
      stale = n;
      logger.warn({ stale: n }, 'reconciler: outbox has stale unprocessed rows');
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.outbox.stale_unprocessed',
          level: 'warning',
          data: { staleCount: n },
        });
      }
    }
  } catch (err) {
    logger.error({ err }, 'reconciler: stale-outbox probe failed');
  }

  try {
    autonomousReset = await resetAutonomousWedgesOnce();
  } catch (err) {
    logger.error({ err }, 'reconciler: autonomous wedge pass failed');
  }

  return { rescued, stale, autonomousReset };
}

/**
 * ISS-890 — the driver's wedge, and since ISS-895 the only wedge net there is.
 * An agent that ends its session having moved its own issue to `in_progress`
 * leaves it there under a live run with no job — measured on ISS-880 as 2h15m
 * ending in a hand-close. The rescue above cannot see it: that pass selects on
 * the ENTRY status, and `in_progress` is not one.
 *
 * The remedy is to roll the issue BACK to the entry status and let the one
 * dispatch path re-enter it. Nothing here mints a job, so there is no second
 * way for a drive job to be born.
 */
export async function resetAutonomousWedgesOnce(): Promise<number> {
  if (AUTONOMOUS_INFLIGHT_STATUSES.length === 0) return 0;
  let reset = 0;

  const inflightList = sql.join(
    AUTONOMOUS_INFLIGHT_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  // cm:guard NO project filter, and adding one back is how this net gets switched off for the fleet. It used to carry `coalesce(...->>'mode','autonomous') <> 'staged'` — the last reader of a stored column ISS-897 had already stripped from all 38 rows and ISS-895 removed the concept of. There is one lane, so every project is in scope; a filter that finds nothing and a pass that is switched off report the same number.
  const wedged = await db.execute<{
    id: string;
    project_id: string;
    status: string;
    reopen_count: number;
    created_by: string | null;
  }>(sql`
    SELECT i.id, i.project_id, i.status, i.reopen_count, p.created_by
    FROM issues i
    INNER JOIN projects p ON p.id = i.project_id
    CROSS JOIN LATERAL (
      SELECT j.type, j.status
      FROM jobs j
      WHERE j.issue_id = i.id
      ORDER BY j.created_at DESC
      LIMIT 1
    ) lj
    WHERE i.status IN (${inflightList})
      AND i.updated_at < now() - interval '${sql.raw(WEDGE_GRACE)}'
      AND lj.status = 'done'
      AND lj.type = ${AUTONOMOUS_JOB_TYPE}
      AND EXISTS (
        SELECT 1 FROM pipeline_runs r
        WHERE r.issue_id = i.id AND r.kind = 'issue' AND r.status = 'running'
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs j2
        WHERE j2.issue_id = i.id
          AND j2.status IN ('queued', 'dispatched', 'running')
      )
    LIMIT ${WEDGE_RESET_LIMIT}
  `);

  for (const row of wedged) {
    const actorId = row.created_by ?? '<reconciler>';
    try {
      const { capped, runId } = await checkAutonomousRescueCap({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
        reopenCount: row.reopen_count,
      });
      if (capped) continue;

      await applyStatusTransition(
        {
          id: row.id,
          projectId: row.project_id,
          status: row.status as IssueStatus,
          reopenCount: row.reopen_count,
        },
        AUTONOMOUS_ENTRY_STATUS,
        { id: actorId, ownerId: actorId },
        { reason: 'reconciler_autonomous_wedge_reset', skip: true },
      );

      // cm:guard charge the rescue only AFTER the rollback lands. This pass fires only when the previous cycle's drive job is already `done`, so every charge is an observed outcome, never an attempt — and a throwing transition must not spend an allowance the issue never got.
      if (runId) await recordAutonomousRescue(runId);

      reset++;
      logger.warn(
        { issueId: row.id, from: row.status, to: AUTONOMOUS_ENTRY_STATUS },
        'reconciler: reset autonomous driver wedge to the entry status',
      );
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.reconciler.autonomous_wedge_reset',
          level: 'warning',
          data: { issueId: row.id, from: row.status },
        });
      }
    } catch (err) {
      logger.error(
        { err, issueId: row.id, status: row.status },
        'reconciler: autonomous wedge reset failed',
      );
    }
  }

  return reset;
}

/**
 * Register the pg-boss `* * * * *` schedule. Idempotent. Lazy-imports
 * pg-boss so test loaders that don't touch the queue can still resolve
 * this module.
 */
export async function registerReconciler(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).createQueue(RECONCILER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).work(RECONCILER_QUEUE, async () => {
    try {
      await runReconcilerOnce();
    } catch (err) {
      logger.error({ err }, 'reconciler: tick failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).schedule(RECONCILER_QUEUE, '* * * * *');
  registered = true;
}

/** Test-only — reset registration. */
export function resetReconcilerForTest(): void {
  registered = false;
}
