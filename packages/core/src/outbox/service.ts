import {
  OUTBOX_RETENTION_DAYS,
  type OutboxRefusalCode,
  type ReplayOutboxDeliveryResponse,
} from '@forge/contracts/outbox-consumers';
import { sql } from 'drizzle-orm';
import { afterCommit, db } from '../db/client.js';
import type { Refusal } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { wakeOutbox } from './worker.js';

export type ReplayOutcome =
  | ({ ok: true } & ReplayOutboxDeliveryResponse)
  | { ok: false; refusals: (Refusal & { code: OutboxRefusalCode })[] };

/**
 * Sends one dead delivery back to its consumer: pending again, its attempts counted from zero.
 * `projectId` null is the platform admin door, which reaches project-less events too.
 */
async function replay(deliveryId: string, projectId: string | null): Promise<ReplayOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{
      id: string;
      status: string;
      consumer: string;
      event_id: string;
      project_id: string | null;
    }>(sql`
      SELECT d.id, d.status, d.consumer, d.event_id, e.project_id
        FROM outbox_deliveries d JOIN pipeline_outbox e ON e.id = d.event_id
       WHERE d.id = ${deliveryId}
       FOR UPDATE OF d
    `);
    if (!row || (projectId !== null && row.project_id !== projectId)) {
      throw notFound('outbox delivery not found');
    }
    if (row.status !== 'dead') {
      return {
        ok: false as const,
        refusals: [
          {
            code: 'OUTBOX_DELIVERY_NOT_DEAD' as const,
            path: 'deliveryId',
            detail: `delivery ${deliveryId} is ${row.status}; only a dead delivery is replayed`,
          },
        ],
      };
    }
    await tx.execute(sql`
      UPDATE outbox_deliveries
         SET status = 'pending', attempts = 0, next_attempt_at = now(), dead_at = NULL,
             leased_until = NULL, lease_token = NULL
       WHERE id = ${deliveryId}
    `);
    afterCommit(wakeOutbox);
    return {
      ok: true as const,
      act: 'replayed' as const,
      delivery: {
        id: row.id,
        status: 'pending' as const,
        consumer: row.consumer,
        eventId: row.event_id,
      },
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
 * Deletes delivered rows older than `OUTBOX_RETENTION_DAYS`, then events of that age left with no
 * delivery, in batches so no one statement holds the table long. A dead delivery keeps its event.
 */
export async function pruneOutbox(): Promise<{ deliveries: number; events: number }> {
  const out = { deliveries: 0, events: 0 };
  for (;;) {
    const gone = await db.execute<{ id: string }>(sql`
      DELETE FROM outbox_deliveries WHERE id IN (
        SELECT id FROM outbox_deliveries
         WHERE status = 'delivered'
           AND delivered_at < now() - ${OUTBOX_RETENTION_DAYS}::int * interval '1 day'
         LIMIT ${PRUNE_BATCH})
      RETURNING id
    `);
    out.deliveries += gone.length;
    if (gone.length < PRUNE_BATCH) break;
  }
  for (;;) {
    const gone = await db.execute<{ id: string }>(sql`
      DELETE FROM pipeline_outbox WHERE id IN (
        SELECT e.id FROM pipeline_outbox e
         WHERE e.created_at < now() - ${OUTBOX_RETENTION_DAYS}::int * interval '1 day'
           AND NOT EXISTS (SELECT 1 FROM outbox_deliveries d WHERE d.event_id = e.id)
         LIMIT ${PRUNE_BATCH})
      RETURNING id
    `);
    out.events += gone.length;
    if (gone.length < PRUNE_BATCH) break;
  }
  return out;
}
