import { settleSentryDelivery } from '../integrations/sentry/index.js';
import { logger } from '../observability/logger.js';
import { consume } from '../outbox/index.js';
import { intakeSentryIssue, projectCreatedById, readSentryThresholds } from './service.js';

/**
 * The error-intake domain's reaction to an issue an error tracker delivered: decide it, then settle
 * the delivery row the adapter left `pending` with what was decided.
 */
export function registerErrorSightings(): void {
  consume('error.sighted', {
    name: 'error-intake',
    handle: async (p) => {
      const createdById = await projectCreatedById(p.projectId);
      if (!createdById) {
        await settleSentryDelivery(p.deliveryId, {
          refusal:
            'this project has no creator to file Sentry issues as, so the delivery could not be acted on',
        });
        return;
      }
      const outcome = await intakeSentryIssue(p.issue, {
        projectId: p.projectId,
        createdById,
        thresholds: await readSentryThresholds(),
        target: p.target,
        scheduleRunId: null,
      });
      if (outcome.kind === 'refused') {
        await settleSentryDelivery(p.deliveryId, { refusal: outcome.reason });
        logger.info(
          { projectId: p.projectId, deliveryId: p.deliveryId, reason: outcome.reason },
          'error intake: sighting refused by name',
        );
        return;
      }
      await settleSentryDelivery(p.deliveryId, { done: outcome.kind });
      logger.info(
        {
          projectId: p.projectId,
          deliveryId: p.deliveryId,
          shortId: p.issue.shortId,
          outcome: outcome.kind,
        },
        'error intake: sighting acted on',
      );
    },
    onDeadLetter: async (p, error) => {
      await settleSentryDelivery(p.deliveryId, {
        refusal: `this delivery's intake failed part way and was given up on: ${error}. Some of its writes may already have committed; the issue's own comments and metadata are the record of what did.`,
      });
    },
  });
}
