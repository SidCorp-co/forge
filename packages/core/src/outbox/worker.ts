import { sql } from 'drizzle-orm';
import { fromDrizzle, type JobWithMetadata } from 'pg-boss';
import { db } from '../db/client.js';
import { logger } from '../observability/logger.js';
import { traceStep } from '../observability/sentry.js';
import { boss } from '../queue/boss.js';
import { consumerOf, type Delivery, registryMismatches } from './consumers.js';
import { CONSUMER_NAMES, type DeliveryJob, queueOf } from './queues.js';

/** The backstop poll: a commit wakes its consumers in-process, so polling only covers the rest. */
const POLL_SECONDS = 10;

/** pg-boss handed this attempt to another worker (its heartbeat lapsed), or it is settled. */
class LeaseLost extends Error {}

const workers = new Map<string, string>();

async function runDelivery(consumerName: string, job: JobWithMetadata<DeliveryJob>): Promise<void> {
  const queue = queueOf(consumerName);
  const { type, payload } = job.data;
  const attempt = { id: job.id, retryCount: job.retryCount };
  const delivery: Delivery = {
    id: job.id,
    eventId: job.data.eventId,
    createdAt: new Date(job.data.createdAt),
    attempt: job.retryCount + 1,
    inbox: (write) =>
      db.transaction(async (tx) => {
        const out = await write(tx);
        const { affected } = await boss.complete(queue, attempt, null, { db: fromDrizzle(tx, sql) });
        if (affected !== 1) throw new LeaseLost(`delivery ${job.id} is no longer this worker's`);
        return out;
      }),
  };

  const consumer = consumerOf(type, consumerName);
  try {
    if (!consumer) throw new Error(`no consumer \`${consumerName}\` is registered for \`${type}\``);
    await consumer.handle(payload, delivery);
  } catch (err) {
    if (err instanceof LeaseLost) {
      logger.warn({ deliveryId: job.id, consumer: consumerName }, err.message);
      throw err;
    }
    const error = err instanceof Error ? err.message : String(err);
    const died = job.retryCount >= job.retryLimit;
    logger.error(
      { err, deliveryId: job.id, eventId: job.data.eventId, type, consumer: consumerName },
      'outbox: consumer failed',
    );
    traceStep({
      category: died ? 'outbox.dead' : 'outbox.failed',
      level: died ? 'error' : 'warning',
      data: { deliveryId: job.id, type, consumer: consumerName, attempt: delivery.attempt, error },
    });
    if (died && consumer?.onDeadLetter) {
      await consumer.onDeadLetter(payload, error, delivery).catch((hookErr: unknown) =>
        logger.error({ err: hookErr, deliveryId: job.id }, 'outbox: dead-letter handler failed'),
      );
    }
    throw err;
  }
}

/** Called after an emitting transaction commits. A no-op for a consumer this process does not work. */
export function wakeConsumers(consumers: Iterable<string>): void {
  for (const consumer of consumers) {
    const id = workers.get(consumer);
    if (id) boss.notifyWorker(id);
  }
}

/**
 * Starts one worker per consumer queue. Every consumer must be registered first: a registry that
 * disagrees with `OUTBOX_CONSUMERS` refuses to start, naming each disagreement. Idempotent.
 */
export async function startOutboxWorker(): Promise<void> {
  if (workers.size > 0) return;
  const mismatches = registryMismatches();
  if (mismatches.length > 0) {
    throw new Error(`outbox: the registered consumers disagree with OUTBOX_CONSUMERS: ${mismatches.join('; ')}`);
  }
  for (const consumer of CONSUMER_NAMES) {
    const id = await boss.work<DeliveryJob>(
      queueOf(consumer),
      { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: POLL_SECONDS },
      async ([job]) => {
        if (job) await runDelivery(consumer, job);
      },
    );
    workers.set(consumer, id);
  }
}

export async function stopOutboxWorker(): Promise<void> {
  const running = [...workers];
  workers.clear();
  for (const [consumer, id] of running) {
    await boss
      .offWork(queueOf(consumer), { id })
      .catch((err) => logger.warn({ err, consumer }, 'outbox: offWork failed'));
  }
}
