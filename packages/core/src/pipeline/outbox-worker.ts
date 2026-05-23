import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import type { Actor } from './activity.js';
import { hooks } from './hooks.js';

/**
 * ISS-196 — drains the `pipeline_outbox` table and re-emits the `transition`
 * hook out-of-band. Rows are produced by the AFTER UPDATE trigger on
 * `issues.status` so any commit (REST, MCP, raw SQL) reaches subscribers
 * even when the producer process crashed mid-emit.
 *
 * Concurrency: `FOR UPDATE SKIP LOCKED` makes multiple workers safe — each
 * picks a disjoint batch. The advisory lock inside `considerEnqueue`
 * (orchestrator.ts) serialises job insertion per-issue across workers.
 *
 * Retry: any thrown error in a subscriber leaves `processed_at` NULL on
 * that row and increments `attempts` + records `last_error`. The next tick
 * picks the row up again.
 */

const POLL_INTERVAL_MS = 1_000;
const BATCH_LIMIT = 50;

// Index signature lets this satisfy postgres-js's `Record<string, unknown>`
// constraint on `db.execute<T>` without per-property TS noise.
interface OutboxRow extends Record<string, unknown> {
  id: string;
  issue_id: string;
  project_id: string;
  from_status: string;
  to_status: string;
  actor_id: string | null;
  actor_type: string | null;
  reason: string | null;
  attempts: number;
  created_at: Date;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopping = false;

export async function drainOutboxOnce(): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  await db.transaction(async (tx) => {
    const rows = await tx.execute<OutboxRow>(sql`
      SELECT id, issue_id, project_id, from_status, to_status,
             actor_id, actor_type, reason, attempts, created_at
      FROM pipeline_outbox
      WHERE processed_at IS NULL
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH_LIMIT}
    `);

    for (const row of rows) {
      const actor: Actor =
        row.actor_type === 'device'
          ? { type: 'device', id: row.actor_id ?? '<system>' }
          : row.actor_type === 'system'
            ? { type: 'device', id: row.actor_id ?? '<system>' }
            : { type: 'user', id: row.actor_id ?? '<system>' };
      try {
        await hooks.emit('transition', {
          issueId: row.issue_id,
          projectId: row.project_id,
          actor,
          from: row.from_status as IssueStatus,
          to: row.to_status as IssueStatus,
          // reopenCount is not carried on the outbox row (immutable event
          // record) — subscribers that need it can read it from `issues`.
          reopenCount: 0,
          ...(row.reason ? { reason: row.reason } : {}),
        });
        await tx.execute(sql`
          UPDATE pipeline_outbox SET processed_at = now() WHERE id = ${row.id}
        `);
        processed++;
        if (isSentryEnabled()) {
          Sentry.addBreadcrumb({
            category: 'pipeline.outbox.processed',
            level: 'info',
            data: {
              outboxId: row.id,
              issueId: row.issue_id,
              latencyMs: Date.now() - new Date(row.created_at).getTime(),
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await tx.execute(sql`
          UPDATE pipeline_outbox
          SET attempts = attempts + 1, last_error = ${message}
          WHERE id = ${row.id}
        `);
        failed++;
        logger.error({ err, outboxId: row.id }, 'outbox-worker: dispatch failed');
        if (isSentryEnabled()) {
          Sentry.addBreadcrumb({
            category: 'pipeline.outbox.failed',
            level: 'warning',
            data: {
              outboxId: row.id,
              attempts: row.attempts + 1,
              lastError: message,
            },
          });
        }
      }
    }
  });
  return { processed, failed };
}

async function tick(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    await drainOutboxOnce();
  } catch (err) {
    logger.error({ err }, 'outbox-worker: tick failed');
  } finally {
    running = false;
  }
}

/**
 * Start the polling worker. Idempotent — repeated calls are no-ops. Must be
 * invoked after `registerPipelineOrchestrator(hooks)` so subscribers exist
 * before the first drain.
 */
export function registerOutboxWorker(): void {
  if (timer) return;
  stopping = false;
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // Don't keep the event loop alive on shutdown.
  timer.unref?.();
}

/** Test/shutdown helper. */
export async function stopOutboxWorker(): Promise<void> {
  stopping = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Wait out an in-flight tick so the test's tx doesn't race the worker.
  while (running) {
    await new Promise((r) => setTimeout(r, 10));
  }
}
