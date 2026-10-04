import { enqueueDelivery } from '../integrations/outbound-webhooks/index.js';
import { consume } from '../outbox/index.js';

/** Outbound webhooks: each issue move is enqueued once for the project's endpoints. */
export function registerWebhookSubscribers(): void {
  consume('issue.transitioned', {
    name: 'outbound-webhooks',
    handle: async (p) => {
      await enqueueDelivery(p.projectId, 'issue.statusChanged', {
        issueId: p.id,
        from: p.from,
        to: p.to,
        actorId: p.actor.id,
        at: p.at,
      });
    },
  });
}
