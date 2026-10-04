import type { OutboxEventPayload, OutboxEventType } from '@forge/contracts/outbox-events';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { pipelineOutbox } from '../db/schema.js';

export const OUTBOX_CHANNEL = 'forge_outbox';

function idOf(payload: object, key: 'issueId' | 'projectId'): string | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Writes one event on the executor of the act it reports, so the event commits or rolls back with
 * the act. The NOTIFY is transactional too: the worker is woken when the act commits, never before.
 */
export async function emitEvent<T extends OutboxEventType>(
  tx: Tx,
  type: T,
  payload: OutboxEventPayload<T>,
): Promise<void> {
  await emitEvents(tx, [{ type, payload } as OutboxEvent]);
}

export type OutboxEvent = {
  [T in OutboxEventType]: { type: T; payload: OutboxEventPayload<T> };
}[OutboxEventType];

export async function emitEvents(tx: Tx, events: readonly OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.insert(pipelineOutbox).values(
    events.map((e) => ({
      type: e.type,
      issueId: idOf(e.payload, 'issueId'),
      projectId: idOf(e.payload, 'projectId'),
      payload: e.payload,
    })),
  );
  await tx.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, '')`);
}
