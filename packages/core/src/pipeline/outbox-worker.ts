import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import type { Actor } from './activity.js';
import { assertHookDelivered, hooks } from './hooks.js';
import { emitPipelineWedge } from './wedge.js';

/**
 * ISS-196 — drains the `pipeline_outbox` table and re-emits the `transition`
 * hook out-of-band. Rows are produced by the AFTER UPDATE trigger on
 * `issues.status` so any commit (REST, MCP, raw SQL) reaches subscribers
 * even when the producer process crashed mid-emit.
 *
 * ISS-678 — claim-then-emit, not claim-and-emit-in-one-tx. A single
 * `UPDATE ... RETURNING` claims a batch (stamps `claimed_at`) and commits
 * immediately, THEN hooks fire with no transaction open — a subscriber that
 * blocks on a lock no longer pins this connection's MVCC snapshot or the
 * `FOR UPDATE SKIP LOCKED` row locks. A crash between claim and emit leaves
 * `processed_at` NULL under an expired lease, so the next tick re-claims and
 * re-emits: at-least-once survives crashes, exactly as before. Duplicate
 * emits are safe because the orchestrator's per-issue `pg_advisory_xact_lock`
 * + in-lock active-job re-check collapse them (orchestrator.ts).
 *
 * Concurrency: `FOR UPDATE SKIP LOCKED` makes multiple workers safe — each
 * picks a disjoint batch.
 *
 * ISS-831 — a subscriber failure (`EmitResult.failures`, scoped to
 * `pipeline-orchestrator` via `assertHookDelivered`) is now a delivery
 * failure, same as a thrown/rejected emit: the row is left `processed_at`
 * NULL and `claimed_at = now()`, so it is not re-claimable until the
 * `CLAIM_LEASE_MS` lease expires — a free ~120s backoff, no new column.
 * `attempts` counts REdeliveries, not deliveries: it is bumped by
 * `claimBatch`'s own `CASE WHEN claimed_at IS NOT NULL` only when a row is
 * re-claimed after a failure, so the first delivery leaves it at 0. Capped at
 * `MAX_REDELIVERIES` — a row that hits the cap stays `processed_at IS NULL`
 * forever (VISION №10: never silently mark it done) and raises a
 * `pipeline_wedge` naming the issue and the stuck status.
 *
 * Accepted tradeoff: a retry re-emits to EVERY subscriber, not just the one
 * that failed (no per-subscriber redelivery targeting — that needs
 * persisting subscriber identity per outbox row, out of scope). Bounded by
 * `MAX_REDELIVERIES`: the orchestrator is idempotent under its per-issue
 * `pg_advisory_xact_lock`, so its redelivery is a real retry; other
 * subscribers may write up to `MAX_REDELIVERIES` duplicate rows (activity,
 * notifications) — cosmetic, and notification dedupe is tracked separately.
 */

const POLL_INTERVAL_MS = 1_000;
const BATCH_LIMIT = 50;
const CLAIM_LEASE_MS = 120_000;
// cm:why counts REdeliveries (see module header) — the filter `attempts < MAX_REDELIVERIES` therefore allows 1 initial delivery + MAX_REDELIVERIES retries before dead-lettering
const MAX_REDELIVERIES = 3;

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

// cm:edge contract -> packages/core/src/pipeline/orchestrator.ts — this claim lease's at-least-once guarantee is only sound because considerEnqueue/buildAndEnqueueStepJob dedupe a re-emitted transition per-issue under pg_advisory_xact_lock
async function claimBatch(): Promise<OutboxRow[]> {
  return db.execute<OutboxRow>(sql`
    UPDATE pipeline_outbox o
       SET claimed_at = now(),
           attempts = o.attempts + CASE WHEN o.claimed_at IS NOT NULL THEN 1 ELSE 0 END
      FROM (
        SELECT id FROM pipeline_outbox
         WHERE processed_at IS NULL
           AND attempts < ${MAX_REDELIVERIES}
           AND (claimed_at IS NULL OR claimed_at < now() - interval '${sql.raw(String(CLAIM_LEASE_MS))} milliseconds')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT ${BATCH_LIMIT}
      ) picked
     WHERE o.id = picked.id
    RETURNING o.id, o.issue_id, o.project_id, o.from_status, o.to_status,
              o.actor_id, o.actor_type, o.reason, o.attempts, o.created_at
  `);
}

export async function drainOutboxOnce(): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  const rows = await claimBatch();

  // cm:guard never await hooks.emit() while a transaction is open on this connection or any other — subscribers (e.g. the orchestrator) open their own tx and can block on an unbounded lock, pinning whatever tx is still around
  for (const row of rows) {
    const actor: Actor =
      row.actor_type === 'device'
        ? { type: 'device', id: row.actor_id ?? '<system>' }
        : row.actor_type === 'system'
          ? { type: 'device', id: row.actor_id ?? '<system>' }
          : { type: 'user', id: row.actor_id ?? '<system>' };
    try {
      const result = await hooks.emit('transition', {
        issueId: row.issue_id,
        projectId: row.project_id,
        actor,
        from: row.from_status as IssueStatus,
        to: row.to_status as IssueStatus,
        // cm:why reopenCount is not carried on the outbox row (immutable event record) — subscribers that need it can read it from `issues`
        reopenCount: 0,
        ...(row.reason ? { reason: row.reason } : {}),
      });
      // cm:edge contract -> packages/core/src/pipeline/hooks.ts — only a `pipeline-orchestrator` failure is escalated; a best-effort subscriber failing (e.g. pm, which has no local guard) must not block delivery or raise a wedge claiming the status change was unprocessed
      assertHookDelivered(result, { owned: ['pipeline-orchestrator'] });
      await db.execute(sql`
        UPDATE pipeline_outbox SET processed_at = now(), claimed_at = NULL WHERE id = ${row.id}
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
      await db.execute(sql`
        UPDATE pipeline_outbox
        SET claimed_at = now(), last_error = ${message}
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
            attempts: row.attempts,
            lastError: message,
          },
        });
      }
      // cm:why this fires exactly once, on the final permitted delivery's failure: claimBatch's `attempts < MAX_REDELIVERIES` filter means a row with attempts === MAX_REDELIVERIES will never be re-claimed, so this is the last chance to surface it
      if (row.attempts >= MAX_REDELIVERIES) {
        await emitPipelineWedge({
          projectId: row.project_id,
          issueId: row.issue_id,
          hop: 'dispatch',
          entity: 'outbox',
          entityId: row.id,
          reason: `transition ${row.from_status} → ${row.to_status} failed after ${MAX_REDELIVERIES} redeliveries: ${message}`,
          action:
            'Inspect the pipeline_outbox row + subscriber logs; the issue may be sitting at its trigger status with no job.',
          title: 'Status change not processed',
          summary: `An issue's move to "${row.to_status}" could not be handed to the pipeline after ${MAX_REDELIVERIES} retries, so no next step was started.`,
          nextStep:
            'Open the issue and re-apply the status change, or check the server logs for the failing subscriber.',
        });
      }
    }
  }
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
