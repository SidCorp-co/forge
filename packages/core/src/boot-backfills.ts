import {
  runActivityFieldChangesBackfillOnce,
  runCriteriaBackfillOnce,
  runRescueCapRehomeOnce,
} from './issues/index.js';
import { logger } from './lib/logger.js';
import { reconcilePinOnlyDesigns } from './workflows/index.js';

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
  const rehome = await runRescueCapRehomeOnce();
  if (rehome) {
    for (const r of rehome.refusals)
      logger.error(
        { issueId: r.issueId, refusal: r.reason },
        'boot: rescue-cap re-home refused an issue; the marker stays unset',
      );
    logger.info(
      { rehomed: rehome.rehomed, left: rehome.left, refused: rehome.refusals.length },
      'boot: rescue-cap parks re-homed to the master',
    );
  }
  // REQ-41 BC-23: a pin-only revision that waited on a person before the rule shipped approves by itself
  const pinOnly = await reconcilePinOnlyDesigns();
  for (const r of pinOnly.refused)
    logger.error(
      { workflowId: r.workflowId, code: r.code, refusal: r.detail },
      'boot: pin-only reconciliation could not compare a design; it stays with a person',
    );
  if (pinOnly.approved.length > 0 || pinOnly.refused.length > 0) {
    logger.info(
      { approved: pinOnly.approved, refused: pinOnly.refused.length },
      'boot: pin-only design revisions approved by themselves',
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
