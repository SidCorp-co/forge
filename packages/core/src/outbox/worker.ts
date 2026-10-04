import type { OutboxEventType } from '@forge/contracts/outbox-events';
import { sql } from 'drizzle-orm';
import { db, listen } from '../db/client.js';
import { logger } from '../logger.js';
import { traceStep } from '../observability/sentry.js';
import { consumersOf, type Delivery } from './consumers.js';
import { OUTBOX_CHANNEL } from './emit.js';

const POLL_INTERVAL_MS = 1_000;
/**
 * ISS-1021 — how far an idle poll backs off. A commit NOTIFYs the worker, so the ceiling bounds the
 * latency only of an event whose notification was lost (a dropped listen connection).
 */
const POLL_MAX_INTERVAL_MS = 8_000;
const BATCH_LIMIT = 50;
const CLAIM_LEASE_MS = 120_000;
export const MAX_REDELIVERIES = 3;

interface OutboxRow extends Record<string, unknown> {
  id: string;
  type: OutboxEventType;
  payload: unknown;
  delivered: string[];
  attempts: number;
  created_at: Date;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;
let stopping = false;
let pollIntervalMs = POLL_INTERVAL_MS;
let unlisten: (() => Promise<void>) | null = null;

async function claimBatch(): Promise<OutboxRow[]> {
  return db.execute<OutboxRow>(sql`
    UPDATE pipeline_outbox o
       SET claimed_at = now(),
           attempts = o.attempts + CASE WHEN o.claimed_at IS NOT NULL THEN 1 ELSE 0 END
      FROM (
        SELECT id FROM pipeline_outbox
         WHERE processed_at IS NULL
           -- A literal, not a parameter: idx_outbox_unprocessed is partial on this predicate, and a
           -- generic plan cannot prove "attempts < $n" implies it (ISS-1021).
           AND attempts < ${sql.raw(String(MAX_REDELIVERIES))}
           AND (claimed_at IS NULL OR claimed_at < now() - interval '${sql.raw(String(CLAIM_LEASE_MS))} milliseconds')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT ${BATCH_LIMIT}
      ) picked
     WHERE o.id = picked.id
    RETURNING o.id, o.type, o.payload, o.delivered, o.attempts, o.created_at
  `);
}

interface Failure {
  consumer: string;
  error: string;
}

/** Runs every consumer of the row not yet through, in registration order. */
async function deliver(row: OutboxRow): Promise<{ through: string[]; failures: Failure[] }> {
  const delivery: Delivery = { eventId: row.id, createdAt: new Date(row.created_at) };
  const through: string[] = [];
  const failures: Failure[] = [];
  for (const consumer of consumersOf(row.type)) {
    if (row.delivered.includes(consumer.name)) continue;
    try {
      await consumer.handle(row.payload as never, delivery);
      through.push(consumer.name);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, eventId: row.id, type: row.type, consumer: consumer.name },
        'outbox: consumer failed',
      );
      failures.push({ consumer: consumer.name, error });
    }
  }
  return { through, failures };
}

async function deadLetter(row: OutboxRow, failures: readonly Failure[]): Promise<void> {
  const delivery: Delivery = { eventId: row.id, createdAt: new Date(row.created_at) };
  for (const failure of failures) {
    const consumer = consumersOf(row.type).find((c) => c.name === failure.consumer);
    if (!consumer?.onDeadLetter) continue;
    try {
      await consumer.onDeadLetter(row.payload as never, failure.error, delivery);
    } catch (err) {
      logger.error(
        { err, eventId: row.id, consumer: failure.consumer },
        'outbox: dead-letter handler failed',
      );
    }
  }
}

export async function drainOutboxOnce(): Promise<{
  processed: number;
  failed: number;
  claimed: number;
}> {
  let processed = 0;
  let failed = 0;
  const rows = await claimBatch();
  for (const row of rows) {
    const { through, failures } = await deliver(row);
    const delivered =
      through.length > 0
        ? sql`delivered || ARRAY[${sql.join(
            through.map((n) => sql`${n}`),
            sql`, `,
          )}]::text[]`
        : sql`delivered`;
    if (failures.length === 0) {
      await db.execute(sql`
        UPDATE pipeline_outbox
           SET processed_at = now(), claimed_at = NULL, delivered = ${delivered}
         WHERE id = ${row.id}
      `);
      processed++;
      continue;
    }
    const lastError = failures.map((f) => `${f.consumer}: ${f.error}`).join('; ');
    await db.execute(sql`
      UPDATE pipeline_outbox
         SET claimed_at = now(), last_error = ${lastError},
             delivered = ${delivered}
       WHERE id = ${row.id}
    `);
    failed++;
    traceStep({
      category: 'outbox.failed',
      level: 'warning',
      data: { eventId: row.id, type: row.type, attempts: row.attempts, lastError },
    });
    if (row.attempts >= MAX_REDELIVERIES) await deadLetter(row, failures);
  }
  return { processed, failed, claimed: rows.length };
}

async function tick(): Promise<void> {
  if (stopping) return;
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    const { claimed } = await drainOutboxOnce();
    pollIntervalMs =
      claimed === 0 ? Math.min(pollIntervalMs * 2, POLL_MAX_INTERVAL_MS) : POLL_INTERVAL_MS;
    if (claimed === BATCH_LIMIT) rerun = true;
  } catch (err) {
    logger.error({ err }, 'outbox: tick failed');
  } finally {
    running = false;
  }
  if (rerun && !stopping) {
    rerun = false;
    pollIntervalMs = POLL_INTERVAL_MS;
    rearm(0);
    return;
  }
  rearm(pollIntervalMs);
}

function rearm(ms: number): void {
  if (stopping) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void tick();
  }, ms);
  timer.unref?.();
}

/** Starts the worker, woken by each commit's NOTIFY and polling as a fallback. Idempotent. Every
 *  consumer must be registered before it starts. */
export async function startOutboxWorker(): Promise<void> {
  if (timer || unlisten) return;
  stopping = false;
  pollIntervalMs = POLL_INTERVAL_MS;
  try {
    const listening = await listen(OUTBOX_CHANNEL, () => {
      pollIntervalMs = POLL_INTERVAL_MS;
      void tick();
    });
    unlisten = listening.unlisten;
  } catch (err) {
    logger.warn({ err }, 'outbox: listen failed; delivering by poll alone');
  }
  rearm(0);
}

export async function stopOutboxWorker(): Promise<void> {
  stopping = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (unlisten) {
    await unlisten().catch(() => {});
    unlisten = null;
  }
  pollIntervalMs = POLL_INTERVAL_MS;
  while (running) {
    await new Promise((r) => setTimeout(r, 10));
  }
}
