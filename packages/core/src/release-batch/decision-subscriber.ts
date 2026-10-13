import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { TERMINAL_PIPELINE_RUN_STATUSES } from '../pipeline/status-sets.js';
import { requeueOnAnswer, voidOnRunEnd } from './decision-hold.js';

const TERMINAL_STATUSES = new Set<string>(TERMINAL_PIPELINE_RUN_STATUSES);

/**
 * A held release goes on when the last question of its decision is answered, and its open questions
 * are voided when the release ends before that.
 */
export function registerReleaseDecisionSubscriber(bus: HooksBus): void {
  bus.on(
    'questionAnswered',
    async (p) => {
      try {
        await requeueOnAnswer(p.questionId);
      } catch (err) {
        logger.error(
          { err, questionId: p.questionId },
          'release-batch: a held release could not be resumed on an answer',
        );
        throw err;
      }
    },
    { name: 'release-decision-requeue' },
  );

  bus.on(
    'pipelineRunStatusChanged',
    async (p) => {
      if (!TERMINAL_STATUSES.has(p.toStatus)) return;
      try {
        await voidOnRunEnd(p.runId, p.toStatus);
      } catch (err) {
        logger.error(
          { err, runId: p.runId },
          'release-batch: the decision of an ended release could not be voided',
        );
        throw err;
      }
    },
    { name: 'release-decision-void' },
  );
}
