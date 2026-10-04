import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_CAP_MS,
} from '@forge/contracts/outbox-consumers';
import type { OutboxEventType } from '@forge/contracts/outbox-events';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { logger } from '../logger.js';
import { traceStep } from '../observability/sentry.js';
import { consumerOf, type Delivery, registryMismatches } from './consumers.js';

/** The backstop poll: a commit wakes the worker in-process, so polling only covers what it missed. */
const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 8_000;
const BATCH_LIMIT = 20;
/** Deliveries run at once; each may hold a connection for its inbox transaction. */
const CONCURRENCY = 4;
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;

interface ClaimedRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  consumer: string;
  attempts: number;
  lease_token: string;
  type: OutboxEventType;
  payload: unknown;
  created_at: Date | string;
}

/** Another worker took the delivery over (its lease ran out) or it is no longer pending. */
class LeaseLost extends Error {}

let timer: NodeJS.Timeout | null = null;
let started = false;
let running = false;
let rerun = false;
let stopping = false;
let pollMs = POLL_MIN_MS;

/**
 * Claims due deliveries, oldest event first. A delivery waits while an earlier event of the same
 * issue is still pending for the same consumer, in backoff included, so one consumer sees an issue's
 * events in order; a dead one no longer holds the issue back.
 */
async function claimBatch(): Promise<ClaimedRow[]> {
  return db.execute<ClaimedRow>(sql`
    WITH claimed AS (
      UPDATE outbox_deliveries d
         SET attempts = d.attempts + 1,
             leased_until = now() + ${LEASE_MS}::int * interval '1 millisecond',
             lease_token = gen_random_uuid()
        FROM (
          SELECT c.id FROM outbox_deliveries c
           WHERE c.status = 'pending'
             AND c.next_attempt_at <= now()
             AND (c.leased_until IS NULL OR c.leased_until < now())
             AND (c.issue_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM outbox_deliveries p
                    WHERE p.consumer = c.consumer AND p.issue_id = c.issue_id
                      AND p.status = 'pending' AND p.seq < c.seq))
           ORDER BY c.seq
           FOR UPDATE SKIP LOCKED
           LIMIT ${BATCH_LIMIT}
        ) picked
       WHERE d.id = picked.id
      RETURNING d.id, d.event_id, d.consumer, d.attempts, d.lease_token, d.seq
    )
    SELECT claimed.id, claimed.event_id, claimed.consumer, claimed.attempts, claimed.lease_token,
           e.type, e.payload, e.created_at
      FROM claimed JOIN pipeline_outbox e ON e.id = claimed.event_id
     ORDER BY claimed.seq
  `);
}

async function renewLease(row: ClaimedRow): Promise<boolean> {
  const renewed = await db.execute<{ id: string }>(sql`
    UPDATE outbox_deliveries
       SET leased_until = now() + ${LEASE_MS}::int * interval '1 millisecond'
     WHERE id = ${row.id} AND lease_token = ${row.lease_token} AND status = 'pending'
    RETURNING id
  `);
  return renewed.length > 0;
}

async function markDelivered(tx: Tx, row: ClaimedRow): Promise<boolean> {
  const marked = await tx.execute<{ id: string }>(sql`
    UPDATE outbox_deliveries
       SET status = 'delivered', delivered_at = now(), leased_until = NULL, lease_token = NULL,
           last_error = NULL
     WHERE id = ${row.id} AND lease_token = ${row.lease_token} AND status = 'pending'
    RETURNING id
  `);
  return marked.length > 0;
}

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), OUTBOX_RETRY_CAP_MS);
  return Math.round(base * (0.75 + random() * 0.5));
}

/** Records a failed attempt: backoff while attempts remain, else `dead`. Answers whether it died. */
async function recordFailure(row: ClaimedRow, error: string): Promise<boolean> {
  const dead = row.attempts >= OUTBOX_MAX_ATTEMPTS;
  const updated = await db.execute<{ id: string }>(sql`
    UPDATE outbox_deliveries
       SET last_error = ${error.slice(0, 4000)}, leased_until = NULL, lease_token = NULL,
           ${
             dead
               ? sql`status = 'dead', dead_at = now()`
               : sql`next_attempt_at = now() + ${retryDelayMs(row.attempts)}::int * interval '1 millisecond'`
           }
     WHERE id = ${row.id} AND lease_token = ${row.lease_token} AND status = 'pending'
    RETURNING id
  `);
  return dead && updated.length > 0;
}

async function runDelivery(row: ClaimedRow): Promise<'delivered' | 'failed' | 'dead' | 'lost'> {
  let marked = false;
  const delivery: Delivery = {
    id: row.id,
    eventId: row.event_id,
    createdAt: new Date(row.created_at),
    attempt: row.attempts,
    inbox: (write) =>
      db.transaction(async (tx) => {
        const [held] = await tx.execute<{ id: string }>(sql`
          SELECT id FROM outbox_deliveries
           WHERE id = ${row.id} AND lease_token = ${row.lease_token} AND status = 'pending'
           FOR UPDATE
        `);
        if (!held) throw new LeaseLost(`delivery ${row.id} is no longer this worker's`);
        const out = await write(tx);
        if (!(await markDelivered(tx, row))) {
          throw new LeaseLost(`delivery ${row.id} is no longer this worker's`);
        }
        marked = true;
        return out;
      }),
  };

  const heartbeat = setInterval(() => {
    renewLease(row)
      .then((held) => {
        if (!held) logger.warn({ deliveryId: row.id }, 'outbox: lease lost while running');
      })
      .catch((err) => logger.warn({ err, deliveryId: row.id }, 'outbox: lease renewal failed'));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const consumer = consumerOf(row.type, row.consumer);
    if (!consumer) throw new Error(`no consumer \`${row.consumer}\` is registered for \`${row.type}\``);
    await consumer.handle(row.payload, delivery);
    if (marked) return 'delivered';
    return (await markDelivered(db, row)) ? 'delivered' : 'lost';
  } catch (err) {
    if (err instanceof LeaseLost) {
      logger.warn({ deliveryId: row.id, consumer: row.consumer }, err.message);
      return 'lost';
    }
    const error = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, deliveryId: row.id, eventId: row.event_id, type: row.type, consumer: row.consumer },
      'outbox: consumer failed',
    );
    const died = await recordFailure(row, error);
    traceStep({
      category: died ? 'outbox.dead' : 'outbox.failed',
      level: died ? 'error' : 'warning',
      data: { deliveryId: row.id, type: row.type, consumer: row.consumer, attempt: row.attempts, error },
    });
    return died ? 'dead' : 'failed';
  } finally {
    clearInterval(heartbeat);
  }
}

export async function drainOutboxOnce(): Promise<{
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
}> {
  const rows = await claimBatch();
  const tally = { claimed: rows.length, delivered: 0, failed: 0, dead: 0 };
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const row = rows[next++] as ClaimedRow;
      const outcome = await runDelivery(row);
      if (outcome === 'delivered') tally.delivered++;
      else if (outcome === 'failed') tally.failed++;
      else if (outcome === 'dead') tally.dead++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, lane));
  return tally;
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
    pollMs = claimed === 0 ? Math.min(pollMs * 2, POLL_MAX_MS) : POLL_MIN_MS;
    if (claimed > 0) rerun = true;
  } catch (err) {
    logger.error({ err }, 'outbox: tick failed');
  } finally {
    running = false;
  }
  if (rerun && !stopping) {
    rerun = false;
    pollMs = POLL_MIN_MS;
    rearm(0);
    return;
  }
  rearm(pollMs);
}

function rearm(ms: number): void {
  if (stopping) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void tick();
  }, ms);
  timer.unref?.();
}

/** Called after an emitting transaction commits. A no-op in a process that runs no worker. */
export function wakeOutbox(): void {
  if (!started || stopping) return;
  pollMs = POLL_MIN_MS;
  void tick();
}

/**
 * Starts the worker. Every consumer must be registered first: a registry that disagrees with
 * `OUTBOX_CONSUMERS` refuses to start, naming each disagreement. Idempotent.
 */
export async function startOutboxWorker(): Promise<void> {
  if (started) return;
  const mismatches = registryMismatches();
  if (mismatches.length > 0) {
    throw new Error(`outbox: the registered consumers disagree with OUTBOX_CONSUMERS: ${mismatches.join('; ')}`);
  }
  started = true;
  stopping = false;
  pollMs = POLL_MIN_MS;
  rearm(0);
}

export async function stopOutboxWorker(): Promise<void> {
  stopping = true;
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pollMs = POLL_MIN_MS;
  while (running) {
    await new Promise((r) => setTimeout(r, 10));
  }
}
