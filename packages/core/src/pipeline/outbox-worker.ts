import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { logger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import type { Actor } from './activity.js';
import { assertHookDelivered, hooks } from './hooks.js';
import { emitPipelineWedge } from './wedge.js';

const POLL_INTERVAL_MS = 1_000;
/**
 * ISS-1021 — how far an idle poll backs off, and the ceiling it stops at.
 *
 * The worker polled every second forever. Measured on beta 2026-09-17 the table held exactly ONE
 * unprocessed row and it was dead-lettered, so all ~86,400 polls a day claimed nothing. Backing
 * off costs latency only while there is no work: the first row claimed returns the poll to
 * `POLL_INTERVAL_MS`, and a transition that arrives during a backed-off window waits at most
 * `POLL_MAX_INTERVAL_MS`. That ceiling is the priced part of the trade — 8s of added worst-case
 * latency on the first transition after an idle spell, against 86,400 empty round trips a day.
 */
const POLL_MAX_INTERVAL_MS = 8_000;
const BATCH_LIMIT = 50;
const CLAIM_LEASE_MS = 120_000;
export const MAX_REDELIVERIES = 3;

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
let pollIntervalMs = POLL_INTERVAL_MS;

async function claimBatch(): Promise<OutboxRow[]> {
  return db.execute<OutboxRow>(sql`
    UPDATE pipeline_outbox o
       SET claimed_at = now(),
           attempts = o.attempts + CASE WHEN o.claimed_at IS NOT NULL THEN 1 ELSE 0 END
      FROM (
        SELECT id FROM pipeline_outbox
         WHERE processed_at IS NULL
           -- the change. idx_outbox_unprocessed is partial on this same predicate, and a GENERIC
           -- plan cannot prove the predicate is implied by "attempts < $n" because $n is unknown
           -- when that plan is built. A custom plan substitutes the value and does prove it, so
           -- the parameterised form looks fine the first few times it runs — and this statement is
           -- prepared and re-executed every second, which is exactly the shape Postgres switches
           -- to a generic plan for. Measured on a seeded 35,001-row table: literal 0.072ms on an
           -- Index Scan; the same query under force_generic_plan, 6.69ms on a Seq Scan removing
           -- 35,001 rows. That is why the criterion for this is an EXPLAIN naming the index rather
           -- than a reading of the migration file.
           AND attempts < ${sql.raw(String(MAX_REDELIVERIES))}
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

// cm:flow dispatch/outbox after:transition — claims the row the trigger wrote and re-emits it on the hooks bus, out of band from the transaction that produced it
export async function drainOutboxOnce(): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  const rows = await claimBatch();
  const delivered: string[] = [];

  for (const row of rows) {
    const actor: Actor =
      row.actor_type === 'device' || row.actor_type === 'system'
        ? { type: 'device', id: row.actor_id ?? '<system>', agency: 'agent' }
        : { type: 'user', id: row.actor_id ?? '<system>', agency: 'human' };
    try {
      const result = await hooks.emit('transition', {
        issueId: row.issue_id,
        projectId: row.project_id,
        actor,
        from: row.from_status as IssueStatus,
        to: row.to_status as IssueStatus,
        reopenCount: 0,
        outboxId: row.id,
        ...(row.reason ? { reason: row.reason } : {}),
      });
      assertHookDelivered(result, { owned: ['pipeline-orchestrator'] });
      delivered.push(row.id);
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

  if (delivered.length > 0) {
    await db.execute(sql`
      UPDATE pipeline_outbox
         SET processed_at = now(), claimed_at = NULL
       WHERE id IN (${sql.join(
         delivered.map((id) => sql`${id}`),
         sql`, `,
       )})
    `);
  }
  return { processed, failed };
}

async function tick(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    const { processed, failed } = await drainOutboxOnce();
    if (processed === 0 && failed === 0) {
      pollIntervalMs = Math.min(pollIntervalMs * 2, POLL_MAX_INTERVAL_MS);
    } else {
      pollIntervalMs = POLL_INTERVAL_MS;
    }
    rearm();
  } catch (err) {
    logger.error({ err }, 'outbox-worker: tick failed');
    rearm();
  } finally {
    running = false;
  }
}

/** Re-arm the one-shot timer at the current interval. */
function rearm(): void {
  if (stopping) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void tick();
  }, pollIntervalMs);
  timer.unref?.();
}

/**
 * Start the polling worker. Idempotent — repeated calls are no-ops. Must be
 * invoked after `registerPipelineOrchestrator(hooks)` so subscribers exist
 * before the first drain.
 */
export function registerOutboxWorker(): void {
  if (timer) return;
  stopping = false;
  pollIntervalMs = POLL_INTERVAL_MS;
  rearm();
}

/** Test/shutdown helper. */
export async function stopOutboxWorker(): Promise<void> {
  stopping = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pollIntervalMs = POLL_INTERVAL_MS;
  // Wait out an in-flight tick so the test's tx doesn't race the worker.
  while (running) {
    await new Promise((r) => setTimeout(r, 10));
  }
}
