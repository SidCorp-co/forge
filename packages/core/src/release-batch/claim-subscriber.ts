import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function registerReleaseBatchClaimSubscriber(bus: HooksBus): void {
  bus.on('pipelineRunStatusChanged', (p) => {
    if (!TERMINAL_STATUSES.has(p.toStatus)) return;

    void recoverStrandedReleasing(p.runId, {
      reason: `The release batch run ended ${p.toStatus} without finishing or aborting`,
    })
      .then(({ claimsCleared, recovered }) => {
        if (claimsCleared.length > 0) {
          logger.info(
            { runId: p.runId, count: claimsCleared.length, recovered: recovered.length },
            'release-batch: claims released on run close',
          );
        }
      })
      .catch((err) => {
        logger.error({ err, runId: p.runId }, 'release-batch: claim release subscriber failed');
      });
  });
}
