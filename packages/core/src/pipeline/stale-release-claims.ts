import { releaseEndedRunClaims } from '../issues/index.js';
import { logger } from '../observability/logger.js';

export interface StaleReleaseBatchClaimsResult {
  released: number;
}

/**
 * Clear the claims of release runs that ended, so their issues can join another batch.
 *
 * A roster whose run recorded a promotion and is still held at its release step is left claimed: that is
 * the roster `recoverStrandedReleasing` holds on purpose, for a person, and its claims are the
 * only index a `return-to-gate` abort can read it back by.
 */
export async function reapStaleReleaseBatchClaims(): Promise<StaleReleaseBatchClaimsResult> {
  try {
    const count = await releaseEndedRunClaims();
    if (count > 0) {
      logger.info({ count }, 'pipeline-sweeper: stale release-batch claims cleared');
    }
    return { released: count };
  } catch (err) {
    logger.error({ err }, 'pipeline-sweeper: stale release-batch claim reap failed (skipped)');
    return { released: 0 };
  }
}
