import { and, eq } from 'drizzle-orm';
import { Webhook } from 'standardwebhooks';
import { db } from '../../db/client.js';
import { projectWebhooks } from '../../db/schema.js';
import { logger } from '../../observability/logger.js';
import { boss, declareQueue, KEEP_WAITING_JOBS_SECONDS } from '../../queue/boss.js';

export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';
/** Where a delivery lands once its retries are spent; nothing works it, it is the record. */
export const WEBHOOK_DEAD_LETTER_QUEUE = 'webhook-delivery-dead';

interface DeliveryJob {
  webhookId: string;
  event: string;
  data: unknown;
}

export async function enqueueDelivery(
  projectId: string,
  event: string,
  data: unknown,
): Promise<number> {
  const rows = await db
    .select({ id: projectWebhooks.id, events: projectWebhooks.events })
    .from(projectWebhooks)
    .where(and(eq(projectWebhooks.projectId, projectId), eq(projectWebhooks.active, true)));

  const matches = rows.filter((r) => (r.events as string[]).includes(event));

  for (const hook of matches) {
    const payload: DeliveryJob = { webhookId: hook.id, event, data };
    await boss.send(WEBHOOK_DELIVERY_QUEUE, payload, {
      retryLimit: 5,
      retryBackoff: true,
      deadLetter: WEBHOOK_DEAD_LETTER_QUEUE,
    });
  }

  return matches.length;
}

/**
 * POST one event, signed per Standard Webhooks: `webhook-id` is the pg-boss job id, so it holds
 * across retries and a receiver can drop a duplicate; the key is the UTF-8 bytes of the hook's
 * secret. Any non-2xx throws, so pg-boss retries it and then moves it to the dead-letter queue.
 */
export async function handleDelivery(messageId: string, job: DeliveryJob): Promise<void> {
  const [hook] = await db
    .select()
    .from(projectWebhooks)
    .where(eq(projectWebhooks.id, job.webhookId))
    .limit(1);
  if (!hook?.active) {
    logger.info({ webhookId: job.webhookId }, 'webhook-delivery: skipped (missing or inactive)');
    return;
  }

  const sentAt = new Date();
  const body = JSON.stringify({
    event: job.event,
    data: job.data,
    timestamp: sentAt.toISOString(),
  });
  const signature = new Webhook(hook.secret, { format: 'raw' }).sign(messageId, sentAt, body);

  const res = await fetch(hook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': messageId,
      'webhook-timestamp': String(Math.floor(sentAt.getTime() / 1000)),
      'webhook-signature': signature,
      'x-forge-event': job.event,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(
      `webhook delivery ${messageId} to ${hook.url} returned ${res.status}; a non-2xx is a failed delivery`,
    );
  }
  logger.info({ webhookId: hook.id, url: hook.url, status: res.status }, 'webhook-delivery: ok');
}

let registered = false;

export async function registerOutboundDeliveryWorker(): Promise<void> {
  if (registered) return;
  // The dead-letter queue first: a job naming it references the queue row. Its copies wait for
  // ever, so retention is set past any horizon rather than left at pg-boss's 14 days.
  await declareQueue(WEBHOOK_DEAD_LETTER_QUEUE, {
    retentionSeconds: KEEP_WAITING_JOBS_SECONDS,
    deleteAfterSeconds: 0,
  });
  await boss.createQueue(WEBHOOK_DELIVERY_QUEUE);
  await boss.work<DeliveryJob>(WEBHOOK_DELIVERY_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      if (typeof job.data?.webhookId !== 'string') {
        throw new Error(`webhook delivery job ${job.id} carries no webhookId`);
      }
      await handleDelivery(job.id, job.data);
    }
  });
  registered = true;
}
