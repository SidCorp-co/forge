import { enqueueDelivery } from '../integrations/outbound-webhooks/delivery.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';

export function registerWebhookSubscribers(bus: HooksBus): void {
  bus.on('transition', async (payload) => {
    try {
      await enqueueDelivery(payload.projectId, 'issue.statusChanged', {
        issueId: payload.issueId,
        from: payload.from,
        to: payload.to,
        actorId: payload.actor.id,
        at: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err, projectId: payload.projectId }, 'webhook subscriber: enqueue failed');
    }
  });
}
