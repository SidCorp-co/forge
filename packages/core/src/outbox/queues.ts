import { createHash } from 'node:crypto';
import {
  OUTBOX_CONSUMERS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_DELAY_MAX_SECONDS,
  OUTBOX_RETRY_DELAY_SECONDS,
  type OutboxConsumerName,
} from '@forge/contracts/outbox-consumers';
import type { OutboxEventType } from '@forge/contracts/outbox-events';
import type { Queue } from 'pg-boss';
import { declareQueue, KEEP_WAITING_JOBS_SECONDS } from '../queue/boss.js';

/** Every consumer's dead deliveries, copied here by pg-boss: the list the dead routes and A6 read. */
export const DEAD_QUEUE = 'outbox.dead';

const PREFIX = 'outbox.';

export const queueOf = (consumer: string) => `${PREFIX}${consumer}`;

export const CONSUMER_NAMES: readonly OutboxConsumerName[] = [
  ...new Set(Object.values(OUTBOX_CONSUMERS).flat()),
].sort();

/**
 * One consumer's queue. `key_strict_fifo` keyed by issue delivers an issue's events in order and
 * holds them behind an active, retrying or dead one, so a dead delivery blocks the issue for this
 * consumer until it is replayed. pg-boss never deletes from it: a failed job is the block, and
 * completed jobs are pruned by `pruneOutbox`.
 */
const CONSUMER_QUEUE: Omit<Queue, 'name'> = {
  policy: 'key_strict_fifo',
  retryLimit: OUTBOX_MAX_ATTEMPTS - 1,
  retryDelay: OUTBOX_RETRY_DELAY_SECONDS,
  retryBackoff: true,
  retryDelayMax: OUTBOX_RETRY_DELAY_MAX_SECONDS,
  heartbeatSeconds: 30,
  expireInSeconds: 15 * 60,
  deleteAfterSeconds: 0,
  retentionSeconds: KEEP_WAITING_JOBS_SECONDS,
  deadLetter: DEAD_QUEUE,
};

/** The dead-letter copies are waiting jobs nothing works, so retention would be the only thing to drop them. */
const DEAD_LETTER_QUEUE: Omit<Queue, 'name'> = {
  deleteAfterSeconds: 0,
  retentionSeconds: KEEP_WAITING_JOBS_SECONDS,
};

/** Declared before anything emits: an emit sends into these queues. */
export async function declareOutboxQueues(): Promise<void> {
  await declareQueue(DEAD_QUEUE, DEAD_LETTER_QUEUE);
  for (const consumer of CONSUMER_NAMES) await declareQueue(queueOf(consumer), CONSUMER_QUEUE);
}

const consumerTag = (consumer: string) =>
  createHash('sha256').update(consumer).digest('hex').slice(0, 16);

const byTag = new Map(CONSUMER_NAMES.map((c) => [consumerTag(c), c]));

/**
 * The job id of one event's delivery to one consumer: the event's `seq` in the leading eight bytes
 * and the consumer in the rest. pg-boss orders a key's jobs by `created_on`, the emitting
 * transaction's start, then by id, so an issue's events written in one transaction keep `seq`
 * order, and sending the same delivery twice inserts it once.
 */
export function deliveryJobId(seq: number, consumer: string): string {
  const hex = seq.toString(16).padStart(16, '0') + consumerTag(consumer);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function consumerOfDeliveryId(id: string): OutboxConsumerName | undefined {
  return byTag.get(id.replaceAll('-', '').slice(16).toLowerCase());
}

/** What one delivery job carries: the event whole, so a dead delivery outlives the event's row. */
export interface DeliveryJob {
  deliveryId: string;
  eventId: string;
  seq: number;
  type: OutboxEventType;
  consumer: string;
  projectId: string | null;
  issueId: string | null;
  /** ISO 8601, when the event was written. */
  createdAt: string;
  payload: unknown;
}
