import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETENTION_DAYS,
  type OutboxRefusalCode,
  type ReplayOutboxDeliveryResponse,
} from '@forge/contracts/outbox-consumers';
import { sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { afterCommit, db } from '../db/client.js';
import type { Refusal } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { BOSS_SCHEMA, boss } from '../queue/boss.js';
import { consumerOfDeliveryId, DEAD_QUEUE, type DeliveryJob, queueOf } from './queues.js';
import { wakeConsumers } from './worker.js';

export type ReplayOutcome =
  | ({ ok: true } & ReplayOutboxDeliveryResponse)
  | { ok: false; refusals: (Refusal & { code: OutboxRefusalCode })[] };

const notDead = (deliveryId: string, state: string): ReplayOutcome => ({
  ok: false,
  refusals: [
    {
      code: 'OUTBOX_DELIVERY_NOT_DEAD',
      path: 'deliveryId',
      detail: `delivery ${deliveryId} is ${state}; only a dead delivery is replayed`,
    },
  ],
});

/**
 * Sends one dead delivery back to its consumer with a fresh attempt count, and drops its dead-letter
 * copy, in one transaction. Until then it holds back its issue's later deliveries to that consumer.
 * `projectId` null is the platform admin door, which reaches project-less events too.
 */
async function replay(deliveryId: string, projectId: string | null): Promise<ReplayOutcome> {
  const consumer = consumerOfDeliveryId(deliveryId);
  if (!consumer) throw notFound('outbox delivery not found');
  const queue = queueOf(consumer);
  return db.transaction(async (tx) => {
    const executor = fromDrizzle(tx, sql);
    const [job] = await boss.findJobs<DeliveryJob>(queue, { id: deliveryId, db: executor });
    if (!job || (projectId !== null && job.data.projectId !== projectId)) {
      throw notFound('outbox delivery not found');
    }
    if (job.state !== 'failed') return notDead(deliveryId, job.state);
    const { affected } = await boss.retry(queue, deliveryId, { db: executor });
    if (affected !== 1) return notDead(deliveryId, 'no longer dead');
    await boss.update(queue, undefined, {
      id: deliveryId,
      retryLimit: job.retryCount + OUTBOX_MAX_ATTEMPTS,
      db: executor,
    });
    const copies = await boss.findJobs<DeliveryJob>(DEAD_QUEUE, {
      data: { deliveryId },
      db: executor,
    });
    if (copies.length > 0) {
      await boss.deleteJob(
        DEAD_QUEUE,
        copies.map((c) => c.id),
        { db: executor },
      );
    }
    afterCommit(() => wakeConsumers([consumer]));
    return {
      ok: true as const,
      act: 'replayed' as const,
      delivery: { id: deliveryId, status: 'pending' as const, consumer, eventId: job.data.eventId },
    };
  });
}

export async function replayDelivery(input: {
  userId: string | null | undefined;
  projectId: string;
  deliveryId: string;
}): Promise<ReplayOutcome> {
  await requireCan(actorFor(input.userId), 'outbox.replay', projectResource(input.projectId), 'Replaying an outbox delivery');
  return replay(input.deliveryId, input.projectId);
}

/** The platform admin door's replay, the one route to a project-less event's delivery. */
export function replayAnyDelivery(deliveryId: string): Promise<ReplayOutcome> {
  return replay(deliveryId, null);
}

const PRUNE_BATCH = 5_000;

/**
 * Deletes delivered jobs older than `OUTBOX_RETENTION_DAYS` from the consumer queues, then events of
 * that age, in batches so no one statement holds a table long. pg-boss is told never to delete from
 * those queues, because it would delete a dead job with the delivered ones and release the issue it
 * holds back; a dead job and its dead-letter copy are never pruned. A job carries its event whole, so
 * an event row is not kept for a delivery still waiting.
 */
export async function pruneOutbox(): Promise<{ deliveries: number; events: number }> {
  const job = sql`${sql.identifier(BOSS_SCHEMA)}.job`;
  const out = { deliveries: 0, events: 0 };
  for (;;) {
    const gone = await db.execute<{ id: string }>(sql`
      DELETE FROM ${job} WHERE (name, id) IN (
        SELECT name, id FROM ${job}
         WHERE name LIKE 'outbox.%' AND name <> ${DEAD_QUEUE}
           AND state = 'completed'
           AND completed_on < now() - ${OUTBOX_RETENTION_DAYS}::int * interval '1 day'
         LIMIT ${PRUNE_BATCH})
      RETURNING id
    `);
    out.deliveries += gone.length;
    if (gone.length < PRUNE_BATCH) break;
  }
  for (;;) {
    const gone = await db.execute<{ id: string }>(sql`
      DELETE FROM pipeline_outbox WHERE id IN (
        SELECT id FROM pipeline_outbox
         WHERE created_at < now() - ${OUTBOX_RETENTION_DAYS}::int * interval '1 day'
         LIMIT ${PRUNE_BATCH})
      RETURNING id
    `);
    out.events += gone.length;
    if (gone.length < PRUNE_BATCH) break;
  }
  return out;
}
