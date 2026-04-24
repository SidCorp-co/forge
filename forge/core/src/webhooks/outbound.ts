import { and, arrayContains, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectWebhooks } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { signHmacSha256 } from './hmac.js';

export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';

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
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss options types vary across versions
    await (boss as any).send(WEBHOOK_DELIVERY_QUEUE, payload, {
      retryLimit: 5,
      retryBackoff: true,
    });
  }

  return matches.length;
}

export async function handleDelivery(job: DeliveryJob): Promise<void> {
  const [hook] = await db
    .select()
    .from(projectWebhooks)
    .where(eq(projectWebhooks.id, job.webhookId))
    .limit(1);
  if (!hook || !hook.active) {
    logger.info({ webhookId: job.webhookId }, 'webhook-delivery: skipped (missing or inactive)');
    return;
  }

  const body = JSON.stringify({
    event: job.event,
    data: job.data,
    timestamp: new Date().toISOString(),
  });
  const signature = signHmacSha256(hook.secret, body);

  const res = await fetch(hook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forge-signature-256': signature,
      'x-forge-event': job.event,
    },
    body,
  });

  if (res.status >= 500) {
    // transient — re-throw so pg-boss retries
    throw new Error(`webhook delivery ${hook.url} returned ${res.status}`);
  }
  if (res.status >= 400) {
    // permanent — log and complete (no retry)
    logger.warn(
      { webhookId: hook.id, url: hook.url, status: res.status },
      'webhook-delivery: 4xx permanent failure',
    );
    return;
  }
  logger.info({ webhookId: hook.id, url: hook.url, status: res.status }, 'webhook-delivery: ok');
}

let registered = false;

export async function registerOutboundDeliveryWorker(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(WEBHOOK_DELIVERY_QUEUE, { batchSize: 1 }, async (arg: unknown) => {
    const entries = Array.isArray(arg) ? arg : [arg];
    for (const entry of entries) {
      const data = (entry as { data?: DeliveryJob })?.data;
      if (!data || typeof data.webhookId !== 'string') continue;
      await handleDelivery(data);
    }
  });
  registered = true;
}

export function resetOutboundForTest(): void {
  registered = false;
}

// arrayContains is imported for potential future filter push-down; the current
// `events.includes` filter is done in JS to keep the test surface small.
void arrayContains;
