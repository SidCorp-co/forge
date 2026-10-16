import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

export interface StaleReleaseBatchClaimsResult {
  released: number;
}

/**
 * Clear the claims of release runs that ended, so their issues can join another batch.
 *
 * A row still at `releasing` is left claimed: the releasing sweep
 * (`release-batch/releasing-settle.ts`) settles it, naming the run that left it there, and clears
 * the claim in the same write that moves it (ISS-1421).
 */
export async function reapStaleReleaseBatchClaims(): Promise<StaleReleaseBatchClaimsResult> {
  try {
    const released = await db.execute<{ id: string }>(sql`
      UPDATE issues
      SET release_batch_run_id = NULL, updated_at = now()
      WHERE release_batch_run_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pipeline_runs r
          WHERE r.id = issues.release_batch_run_id
            AND r.status NOT IN ('running', 'paused')
        )
        AND issues.status <> 'releasing'
      RETURNING id
    `);
    const count = Array.isArray(released) ? released.length : 0;
    if (count > 0) {
      logger.info({ count }, 'pipeline-sweeper: stale release-batch claims cleared');
    }
    return { released: count };
  } catch (err) {
    logger.error({ err }, 'pipeline-sweeper: stale release-batch claim reap failed (skipped)');
    return { released: 0 };
  }
}
