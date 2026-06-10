import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { reEnqueueForIssue } from './orchestrator.js';
import { AUTO_DISPATCH_STATUSES } from './registry.js';

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

let registered = false;

export async function runReconcilerOnce(): Promise<{ rescued: number; stale: number }> {
  let rescued = 0;
  let stale = 0;

  // Embed AUTO_DISPATCH_STATUSES as a parenthesised list of parameters via
  // sql.join — passing the JS array directly into the template expands it as
  // a record tuple, which Postgres can't cast to text[] (drizzle quirk caught
  // by the ISS-196 forge-test smoke run).
  const statusList = sql.join(
    AUTO_DISPATCH_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  const stuck = await db.execute<{
    id: string;
    project_id: string;
    status: string;
    created_by: string | null;
  }>(sql`
    SELECT i.id, i.project_id, i.status, p.created_by
    FROM issues i
    INNER JOIN projects p ON p.id = i.project_id
    WHERE i.status IN (${statusList})
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
      const actorId = row.created_by ?? '<reconciler>';
      await reEnqueueForIssue({
        projectId: row.project_id,
        issueId: row.id,
        status: row.status as IssueStatus,
        // Synthesise a device principal from the project owner; matches the
        // pattern in orchestrator.resolveSkipDevice (no schema change needed).
        actor: { type: 'device', id: actorId },
        reason: { reconciler: true, reason: 'enqueued_missing' },
      });
      rescued++;
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: 'pipeline.reconciler.enqueued_missing',
          level: 'warning',
          data: { issueId: row.id, status: row.status },
        });
      }
    } catch (err) {
      logger.error(
        { err, issueId: row.id, status: row.status },
        'reconciler: rescue failed',
      );
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

  return { rescued, stale };
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
