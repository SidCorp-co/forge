import { runCriteriaBackfillOnce } from './issues/index.js';
import { logger } from './observability/logger.js';

/**
 * The one-time data backfills, each gated by its `backfill_markers` row. They read domain code, so
 * they run here at boot, after `db/migrate.ts` has applied the schema and before the server
 * listens, rather than inside the migrator, which imports no domain.
 */
export async function runOnceBackfills(): Promise<void> {
  const criteria = await runCriteriaBackfillOnce();
  if (criteria) {
    for (const line of criteria.refusals)
      logger.warn({ refusal: line }, 'boot: criteria backfill refused a row');
    logger.info(
      {
        criteria: criteria.criteria,
        issues: criteria.issues,
        verdicts: criteria.verdicts,
        commitUnresolved: criteria.commitUnresolved,
        refused: criteria.refusals.length,
      },
      'boot: criteria backfill ran',
    );
  }
}
