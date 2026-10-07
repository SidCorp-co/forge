import type {
  DeadOutboxDeliveriesResponse,
  DeadOutboxDelivery,
} from '@forge/contracts/outbox-consumers';
import { sql } from 'drizzle-orm';
import type { JobWithMetadata } from 'pg-boss';
import { db } from '../db/client.js';
import { BOSS_SCHEMA, boss } from '../queue/boss.js';
import { DEAD_QUEUE, type DeliveryJob } from './queues.js';

function errorOf(output: object | null): string | null {
  if (!output) return null;
  const message = (output as { message?: unknown }).message;
  return typeof message === 'string' ? message : JSON.stringify(output);
}

function viewOf(copy: JobWithMetadata<DeliveryJob>): DeadOutboxDelivery {
  const d = copy.data;
  return {
    id: d.deliveryId,
    eventId: d.eventId,
    type: d.type,
    consumer: d.consumer,
    projectId: d.projectId,
    issueId: d.issueId,
    attempts: (copy.sourceRetryCount ?? 0) + 1,
    lastError: errorOf(copy.sourceOutput),
    createdAt: d.createdAt,
    deadAt: new Date(copy.createdOn).toISOString(),
  };
}

/**
 * Every dead delivery, newest first: pg-boss copies a consumer's job into `DEAD_QUEUE` when it runs
 * out of attempts, and replay deletes the copy.
 */
async function readAllDead(): Promise<DeadOutboxDelivery[]> {
  const copies = await boss.findJobs<DeliveryJob>(DEAD_QUEUE, {});
  return copies
    .map(viewOf)
    .sort((a, b) => b.deadAt.localeCompare(a.deadAt) || a.id.localeCompare(b.id));
}

/** Every dead delivery, for the platform admin door. */
export async function listAllDeadDeliveries(
  limit: number,
  offset: number,
): Promise<DeadOutboxDeliveriesResponse> {
  const all = await readAllDead();
  return { deliveries: all.slice(offset, offset + limit), total: all.length };
}

interface DeadDeliveryTally {
  count: number;
  oldestDeadAt: string | null;
  sample: DeadOutboxDelivery[];
}

/** How many deliveries are dead, the oldest, and the newest few: what the ops alert reads. */
export async function tallyDeadDeliveries(sampleSize: number): Promise<DeadDeliveryTally> {
  const all = await readAllDead();
  return {
    count: all.length,
    oldestDeadAt: all.at(-1)?.deadAt ?? null,
    sample: all.slice(0, sampleSize),
  };
}

/**
 * Deliveries their worker could take now that have waited more than `overdueMs`: the workers are
 * not draining. pg-boss has no count of this, so it is read from its job table with the head rule
 * its `key_strict_fifo` fetch applies: one held behind an active, retrying, dead or earlier delivery
 * of its issue is waiting, not overdue.
 */
export async function countOverdueDeliveries(overdueMs: number): Promise<number> {
  const job = sql`${sql.identifier(BOSS_SCHEMA)}.job`;
  const [row] = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM ${job} j
     WHERE j.name LIKE 'outbox.%' AND j.name <> ${DEAD_QUEUE}
       AND j.state IN ('created', 'retry')
       AND j.start_after < now() - ${overdueMs}::int * interval '1 millisecond'
       AND NOT EXISTS (
             SELECT 1 FROM ${job} b
              WHERE b.name = j.name AND b.singleton_key = j.singleton_key AND b.id <> j.id
                AND (b.state IN ('active', 'retry', 'failed')
                     OR (j.state = 'created' AND b.state = 'created' AND b.start_after <= now()
                         AND (b.created_on, b.id) < (j.created_on, j.id))))
  `);
  return row?.count ?? 0;
}
