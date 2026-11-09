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
      if (TERMINAL_STATUSES.has(p.to)) await releaseClaimsOnClose(p.id, p.to);
    },
  });
  // a ship that closed its run in the same unit is that close's one report (ISS-1181)
  consume('release.shipped', {
    name: 'release-batch-claims',
    handle: async (p) => {
      if (p.runCompleted) await releaseClaimsOnClose(p.runId, 'completed');
    },
  });
}

async function releaseClaimsOnClose(runId: string, to: string): Promise<void> {
  const { claimsCleared, recovered } = await recoverStrandedReleasing(runId, {
    reason: `The release batch run ended ${to} without finishing or aborting`,
  });
  if (claimsCleared.length > 0) {
    logger.info(
      { runId, count: claimsCleared.length, recovered: recovered.length },
      'release-batch: claims released on run close',
    );
  }
}
