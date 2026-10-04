import { consumersOfType } from '@forge/contracts/outbox-consumers';
import type { OutboxEventPayload, OutboxEventType } from '@forge/contracts/outbox-events';
import { afterCommit, type Tx } from '../db/client.js';
import { outboxDeliveries, pipelineOutbox } from '../db/schema-outbox.js';
import { wakeOutbox } from './worker.js';

function idOf(payload: object, key: 'issueId' | 'projectId'): string | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export type OutboxEvent = {
  [T in OutboxEventType]: { type: T; payload: OutboxEventPayload<T> };
}[OutboxEventType];

/**
 * Writes one event, and one delivery per consumer `OUTBOX_CONSUMERS` names for its type, on the
 * executor of the act it reports, so they commit or roll back with the act. The worker is woken
 * in-process once that transaction commits; nothing is signalled from inside it.
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
    .returning({
      id: pipelineOutbox.id,
      type: pipelineOutbox.type,
      issueId: pipelineOutbox.issueId,
      seq: pipelineOutbox.seq,
    });
  await tx.insert(outboxDeliveries).values(
    written.flatMap((e) =>
      consumersOfType(e.type).map((consumer) => ({
        eventId: e.id,
        consumer,
        issueId: e.issueId,
        seq: e.seq,
      })),
    ),
  );
  afterCommit(wakeOutbox);
}
