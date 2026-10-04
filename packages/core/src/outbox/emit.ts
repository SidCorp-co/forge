import { consumersOfType } from '@forge/contracts/outbox-consumers';
import type { OutboxEventPayload, OutboxEventType } from '@forge/contracts/outbox-events';
import { sql } from 'drizzle-orm';
import { fromDrizzle, type JobInsert } from 'pg-boss';
import { afterCommit, type Tx } from '../db/client.js';
import { pipelineOutbox } from '../db/schema-outbox.js';
import { boss } from '../queue/boss.js';
import { type DeliveryJob, deliveryJobId, queueOf } from './queues.js';
import { wakeConsumers } from './worker.js';

function idOf(payload: object, key: 'issueId' | 'projectId'): string | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

type OutboxEvent = {
  [T in OutboxEventType]: { type: T; payload: OutboxEventPayload<T> };
}[OutboxEventType];

/**
 * Writes one event, and one pg-boss job per consumer `OUTBOX_CONSUMERS` names for its type, on the
 * executor of the act it reports, so they commit or roll back with the act. The consumers' workers
 * are woken in-process once that transaction commits; nothing is signalled from inside it.
 */
export async function emitEvent<T extends OutboxEventType>(
  tx: Tx,
  type: T,
  payload: OutboxEventPayload<T>,
): Promise<void> {
  await emitEvents(tx, [{ type, payload } as OutboxEvent]);
}

export async function emitEvents(tx: Tx, events: readonly OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  const written = await tx
    .insert(pipelineOutbox)
    .values(
      events.map((e) => ({
        type: e.type,
        issueId: idOf(e.payload, 'issueId'),
        projectId: idOf(e.payload, 'projectId'),
        payload: e.payload,
      })),
    )
    .returning();

  const byConsumer = new Map<string, JobInsert<DeliveryJob>[]>();
  for (const e of written) {
    for (const consumer of consumersOfType(e.type)) {
      const deliveryId = deliveryJobId(e.seq, consumer);
      const jobs = byConsumer.get(consumer) ?? [];
      jobs.push({
        id: deliveryId,
        singletonKey: e.issueId ?? `event:${e.id}`,
        data: {
          deliveryId,
          eventId: e.id,
          seq: e.seq,
          type: e.type,
          consumer,
          projectId: e.projectId,
          issueId: e.issueId,
          createdAt: e.createdAt.toISOString(),
          payload: e.payload,
        },
      });
      byConsumer.set(consumer, jobs);
    }
  }
  const executor = fromDrizzle(tx, sql);
  for (const [consumer, jobs] of byConsumer) {
    await boss.insert(queueOf(consumer), jobs, { db: executor });
  }
  afterCommit(() => wakeConsumers(byConsumer.keys()));
}
