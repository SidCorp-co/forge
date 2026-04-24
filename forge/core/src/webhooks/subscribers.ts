import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { enqueueDelivery } from './outbound.js';

/**
 * Subscribe the outbound webhook fan-out to the `transition` hook. On every
 * issue status change, enqueue deliveries for each matching active webhook
 * on the project.
 */
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
