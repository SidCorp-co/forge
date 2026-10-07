import { runActivityFieldChangesBackfillOnce, runCriteriaBackfillOnce } from './issues/index.js';
import { logger } from './lib/logger.js';

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

/**
 * The backfills too heavy to hold the boot (ISS-124): started after the server listens, off the
 * request path, and never awaited. A failure is logged and the next boot continues; each is
 * resumable by its own marker.
 */
export function startDeferredBackfills(): void {
  void runActivityFieldChangesBackfillOnce()
    .then((report) => {
      if (!report) return;
      for (const r of report.refusals)
        logger.error(
          { issueId: r.issueId, refusal: r.reason },
          'boot: activity backfill refused an issue chain; the marker stays unset',
        );
      logger.info(
        { chains: report.chains, rows: report.rows, refused: report.refusals.length },
        'boot: activity field-changes backfill ran',
      );
    })
    .catch((err) => logger.error({ err }, 'boot: activity field-changes backfill failed'));
}
