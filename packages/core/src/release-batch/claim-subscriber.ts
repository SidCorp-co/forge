import { TERMINAL_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';

const TERMINAL_STATUSES = new Set<string>(TERMINAL_PIPELINE_RUN_STATUSES);

/** A run that ended without finishing or aborting its release batch releases the batch's claims. */
export function registerReleaseBatchClaimSubscriber(): void {
  consume('run.transitioned', {
    name: 'release-batch-claims',
    handle: async (p) => {
      if (!TERMINAL_STATUSES.has(p.to)) return;
      const { claimsCleared, recovered } = await recoverStrandedReleasing(p.id, {
        reason: `The release batch run ended ${p.to} without finishing or aborting`,
      });
      if (claimsCleared.length > 0) {
        logger.info(
          { runId: p.id, count: claimsCleared.length, recovered: recovered.length },
          'release-batch: claims released on run close',
        );
      }
    },
  });
}
