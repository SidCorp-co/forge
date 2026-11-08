import { db } from './db/client.js';
import {
  backfillCloseVerdicts,
  drainStaleBuilderFacts,
  runActivityFieldChangesBackfillOnce,
  runCriteriaBackfillOnce,
  runRescueCapRehomeOnce,
} from './issues/index.js';
import { logger } from './lib/logger.js';
import { drainStaleCriteriaFacts } from './requirements/index.js';
import { retireStaleDraftQuestionsOnce, runStewardReaskOnce } from './steward/index.js';

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
  // D2: issues closed before a close recorded its builder's verdict, once (`close-verdicts.ts`)
  const closed = await backfillCloseVerdicts();
  if (closed) {
    logger.info(
      {
        projects: closed.projects,
        issues: closed.issues,
        verdicts: closed.verdicts,
        independent: closed.independent,
      },
      'boot: close verdicts backfilled on projects that judge their own work',
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
  const reask = await runStewardReaskOnce();
  if (reask) {
    for (const r of reask.refusals)
      logger.error(
        { questionId: r.questionId, refusal: r.reason },
        "boot: the steward's free-form question was not voided; the marker stays unset",
      );
    logger.info(
      { voided: reask.voided, reasked: reask.reasked, refused: reask.refusals.length },
      "boot: the steward's free-form questions voided and their items diagnosed again",
    );
  }
  const retired = await retireStaleDraftQuestionsOnce();
  if (retired) {
    for (const r of retired.refusals)
      logger.error(
        { questionId: r.questionId, refusal: r.reason },
        'boot: a stale-draft question was not voided; the marker stays unset',
      );
    logger.info(
      {
        voided: retired.voided,
        rediagnosed: retired.rediagnosed,
        refused: retired.refusals.length,
      },
      'boot: the stale-draft questions voided and their stuck items diagnosed again',
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
  void fillBuilderFacts()
    .then((n) => {
      if (n > 0) logger.info({ issues: n }, 'boot: builder facts written for the marked issues');
    })
    .catch((err) => logger.error({ err }, 'boot: writing the marked builder facts failed'))
    // the criteria facts carry the builder flags, so they are written after them (0633)
    .then(() => fillCriteriaFacts())
    .then((n) => {
      if (n) logger.info({ issues: n }, 'boot: criteria facts written for the marked issues');
    })
    .catch((err) => logger.error({ err }, 'boot: writing the marked criteria facts failed'));
}

/** Rewrites every issue marked for its builder facts, 0627's backfill among them, a batch at a time. */
async function fillBuilderFacts(): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await drainStaleBuilderFacts(db, 200);
    total += n;
    if (n === 0) return total;
  }
}

/** Rewrites every issue marked for its criteria facts, 0633's backfill among them, a batch at a time. */
async function fillCriteriaFacts(): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await drainStaleCriteriaFacts(db, 200);
    total += n;
    if (n === 0) return total;
  }
}
