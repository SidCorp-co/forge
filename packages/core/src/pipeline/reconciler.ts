import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { applyStatusTransition } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { wakeMastersForProject } from '../ws/master-wake.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_INFLIGHT_STATUSES,
  AUTONOMOUS_JOB_TYPE,
} from './autonomous-mode.js';
import { checkAutonomousRescueCap, recordAutonomousRescue } from './autonomous-rescue-cap.js';

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

const WEDGE_GRACE = '10 minutes';
const WEDGE_RESET_LIMIT = 50;

let registered = false;

export async function runReconcilerOnce(): Promise<{
  rescued: number;
  stale: number;
  autonomousReset: number;
}> {
  let rescued = 0;
  let stale = 0;
  let autonomousReset = 0;

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
      AND i.merged_at IS NULL
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
      const cap = await checkAutonomousRescueCap({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
        reopenCount: row.reopen_count,
      });
      if (cap.capped) continue;
      const autonomousRunId: string | null = cap.runId;

      const { boxes } = await wakeMastersForProject({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
      });

      if (boxes === 0) continue;

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
 * A dead session leaves the same wedge by a different road, and until
 * 2026-09-11 nothing could see that one. `in_progress` is the only status that
 * is a driver status and neither the entry nor the question, so it is reachable
 * ONLY from the run that put the issue there: it cannot be admitted to a
 * master's backlog (`BACKLOG_ADMISSIBLE_STATUSES` subtracts the driver
 * statuses) and the entry-status rescue does not select it. When that run ends
 * without moving the issue on, nothing in the system is looking at it again.
 * Measured on sidpeak that day: eleven issues at `in_progress`, no issue-kind
 * run in `running` anywhere on the project, and the oldest of them eight days
 * stranded — work on seven pushed branches that no box would ever offer.
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
      AND lj.type = ${AUTONOMOUS_JOB_TYPE}
      AND NOT EXISTS (
        SELECT 1 FROM jobs j2
        WHERE j2.issue_id = i.id
          AND j2.status IN ('queued', 'dispatched', 'running')
      )
      AND (
        (
          lj.status = 'done'
          AND EXISTS (
            SELECT 1 FROM pipeline_runs r
            WHERE r.issue_id = i.id AND r.kind = 'issue' AND r.status = 'running'
          )
        )
        OR (
          i.merged_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM pipeline_runs r2
            WHERE r2.issue_id = i.id
              AND r2.kind = 'issue'
              AND r2.status IN ('running', 'paused')
          )
        )
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
