// ISS-1117 — an issue at `awaiting_release` releases without a person acting, on a project
// whose release policy already leaves nobody an act (production deploying `on-land` + a resolvable
// release gate) and whose waiting issue has every numbered acceptance criterion earned
// (`criteria-verdicts.ts`). Precedent: `runs-concluded.ts`'s own-tick noticing. The manual
// doors (`collectReleaseBlockers`, `forge advance`) are untouched; this only filters the
// unattended path. ISS-1215: every way it declines a waiting row is a hold record on that row
// (`release-batch/hold.ts`), never on the log alone — and so is what `closeShippedEarlier` could
// not settle about a row, said beside whatever holds it (`shipped-earlier-hold.ts`).

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  heldByEndedRelease,
  heldByEndedReleaseIds,
  type IssueCriteriaReport,
  unearnedCriteriaReports,
} from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { advanceSweep, type SweepPosition, sweepWindow } from '../pipeline/index.js';
import { cutWaitingRelease, loadCreatedBy } from '../schedules/index.js';
import { RELEASE_GATE_STATUS, resolveReleaseGate } from './gate.js';
import {
  abortBlockedIssues,
  clearProjectReleaseHolds,
  clearReleaseHolds,
  clearStaleReleaseHolds,
  criteriaHold,
  criteriaUnreadableHold,
  cutFailedHold,
  gateUnreadableHold,
  NO_ACTOR_HOLD,
  NO_RELEASE_GATE_HOLD,
  queuedBehindHold,
  type ReleaseHold,
  refusalHold,
  restateAbortHolds,
  runtimeUnroutedHold,
  targetUndeclaredHold,
  writeReleaseHolds,
} from './hold.js';
import { productionDeploysOnLand } from './production-trigger.js';
import { waitingIssueIds } from './queries.js';
import {
  reportClaimedFailure,
  reportHeldBack,
  reportUncorroborated,
} from './release-sweep-report.js';
import { readWeighingNow } from './runtime-weighing.js';
import { readServingNow } from './serving-reading.js';
import { closeShippedEarlier, type ShippedEarlierDeps } from './shipped-earlier.js';
import { type ShippedEarlierUnsettled, withShippedEarlier } from './shipped-earlier-hold.js';

const CANDIDATE_CURSOR_KEY = 'release-sweep';
const CANDIDATE_PAGE_LIMIT = 200;

export interface AutomaticReleaseSweepResult {
  /** How many projects had at least one issue cut this tick. */
  projectsCut: number;
  /** How many issues were claimed into an automatic release this tick. */
  issuesCut: number;
  /** How many waiting issues were left alone this tick for an unearned criterion. */
  issuesExcluded: number;
  /** How many waiting issues had a hold written or replaced this tick, for any reason. */
  holdsWritten: number;
  /** How many waiting issues were closed against an earlier release that already shipped their commit. */
  shippedEarlier: number;
}

interface CandidateRow {
  id: string;
  project_id: string;
  cursor_ts: string;
}

// Projects with an `awaiting_release` issue that is unclaimed or still claimed by a release that
// ended unshipped (`heldByEndedRelease`), via a bounded, resumable keyset page (`sweep-cursor.ts`)
// so a project stuck behind 200 others is reached within a few ticks.
async function candidateProjectIds(now: Date): Promise<string[]> {
  const window = sweepWindow(CANDIDATE_CURSOR_KEY, now.toISOString());
  const after = window.after;
  const resume = after
    ? sql`AND (i.updated_at, i.id) > (${after.ts}::timestamptz, ${after.id}::uuid)`
    : sql``;

  const rows = (await db.execute(sql`
    SELECT i.id, i.project_id, i.updated_at::text AS cursor_ts
      FROM issues i
     WHERE i.status = 'awaiting_release'
       AND (i.release_batch_run_id IS NULL OR ${heldByEndedRelease(sql`i.release_batch_run_id`)})
       AND i.updated_at <= ${window.until}::timestamptz
       ${resume}
     ORDER BY i.updated_at ASC, i.id ASC
     LIMIT ${CANDIDATE_PAGE_LIMIT}
  `)) as unknown as CandidateRow[];

  const filled = rows.length === CANDIDATE_PAGE_LIMIT;
  const lastRow = rows.at(-1);
  const last: SweepPosition | null = lastRow ? { ts: lastRow.cursor_ts, id: lastRow.id } : null;
  advanceSweep(CANDIDATE_CURSOR_KEY, window, last, filled);
  if (filled) {
    logger.warn(
      { limit: CANDIDATE_PAGE_LIMIT, resumesAfter: last?.ts ?? null },
      'release-sweep: the candidate scan filled its page — the rest is read on later ticks',
    );
  }

  return [...new Set(rows.map((r) => r.project_id))];
}

interface HoldWrite {
  projectId: string;
  issueIds: string[];
  holdFor: (issueId: string) => ReleaseHold;
  /** What this tick could not settle about whether a row already shipped, said on its hold. */
  unsettled: ReadonlyMap<string, ShippedEarlierUnsettled>;
  now: Date;
  result: AutomaticReleaseSweepResult;
}

async function hold(write: HoldWrite): Promise<void> {
  const tally = await writeReleaseHolds({
    ...write,
    holdFor: (id) => withShippedEarlier(write.holdFor(id), write.unsettled.get(id)),
  });
  write.result.holdsWritten += tally.written;
  if (tally.written > 0) {
    logger.info(
      { projectId: write.projectId, written: tally.written, unchanged: tally.unchanged },
      'release-sweep: the reason these issues are held is recorded on each of them',
    );
  }
}

/** One reason recorded alike on every row named. */
async function holdAlike(write: Omit<HoldWrite, 'holdFor'>, reason: ReleaseHold): Promise<void> {
  await hold({ ...write, holdFor: () => reason });
}

/**
 * Each held row's criteria hold — or, where nothing can read what the project serves, the one
 * project-level reason, recorded alike (ISS-1346).
 */
async function holdOnCriteria(
  write: Omit<HoldWrite, 'holdFor'>,
  heldById: ReadonlyMap<string, IssueCriteriaReport>,
): Promise<void> {
  const serving = heldById.values().next().value?.serving;
  if (serving?.kind !== 'undeclared') {
    await hold({
      ...write,
      holdFor: (id) => criteriaHold(heldById.get(id) as IssueCriteriaReport),
    });
    return;
  }
  await holdAlike(write, runtimeUnroutedHold(serving.missing, serving.route));
}

/** The gate, or the hold every waiting row gets because there is none to read. */
async function readGate(
  projectId: string,
): Promise<{ ok: true } | { ok: false; hold: ReleaseHold }> {
  try {
    const gate = await resolveReleaseGate(projectId);
    return gate ? { ok: true } : { ok: false, hold: NO_RELEASE_GATE_HOLD };
  } catch (err) {
    if (isRefusal(err, 'RELEASE_TARGET_UNDECLARED')) {
      return { ok: false, hold: targetUndeclaredHold(err.refusals[0]?.detail ?? '') };
    }
    logger.error({ err, projectId }, 'release-sweep: the release gate could not be read');
    return {
      ok: false,
      hold: gateUnreadableHold(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * The criteria reports, or a hold naming why the verdicts could not be read.
 *
 * One reading of what the project is serving is taken here and shared by every waiting issue: they
 * are one project's rows weighed against one answer about that project, at one moment (ISS-1286).
 * `readServingNow` answers rather than throwing for a host that will not talk — an unreachable
 * probe is a reading this gate has, not a criteria read that failed — so only a tracker or database
 * failure reaches the catch below. The weighing beside it (ISS-1368) answers a repository that will
 * not talk the same way, as a reason kept on each pair it could not read.
 */
async function readCriteria(
  projectId: string,
  waiting: string[],
): Promise<{ ok: true; value: IssueCriteriaReport[] } | { ok: false; hold: ReleaseHold }> {
  try {
    const serving = await readServingNow(projectId);
    const weighing = await readWeighingNow(projectId, serving, waiting);
    return { ok: true, value: await unearnedCriteriaReports(waiting, serving, weighing) };
  } catch (err) {
    logger.error({ err, projectId }, 'release-sweep: the criteria could not be read');
    return {
      ok: false,
      hold: criteriaUnreadableHold(err instanceof Error ? err.message : String(err)),
    };
  }
}

async function sweepProject(
  projectId: string,
  result: AutomaticReleaseSweepResult,
  now: Date,
  deps: ShippedEarlierDeps,
): Promise<void> {
  if (!(await productionDeploysOnLand(projectId))) {
    await clearProjectReleaseHolds(projectId);
    return;
  }

  const owner = (await loadCreatedBy(projectId)) ?? null;
  // First of all, before a row an aborted release held for a person is set aside: a commit an
  // earlier release already shipped is closed against that release, whatever held it, so no cut
  // is opened to find nothing new in its range. A row a release that ended unshipped still claims
  // is asked the same, and only that: it is not this sweep's to weigh or cut.
  const gate = await waitingIssueIds(projectId);
  const endedHolds = await heldByEndedReleaseIds(projectId, RELEASE_GATE_STATUS);
  const earlier = await closeShippedEarlier(
    { projectId, issueIds: [...gate, ...endedHolds], userId: owner },
    deps,
  );
  result.shippedEarlier += earlier.closed.length;
  const shipped = new Set(earlier.closed.map((c) => c.issueId));
  const unsettled = new Map(earlier.unresolved.map((u) => [u.issueId, u]));
  const atGate = gate.filter((id) => !shipped.has(id));
  // Next, so no later hold replaces the abort's: a row a person owes is not weighed at all, and
  // its abort hold only gains or loses the words naming what could not be settled above.
  const blocked = await abortBlockedIssues(atGate);
  const restated = await restateAbortHolds({ projectId, issueIds: [...blocked], unsettled, now });
  result.holdsWritten += restated.written;
  const waiting = atGate.filter((id) => !blocked.has(id));
  if (waiting.length === 0) return;
  const base = { projectId, now, result, unsettled };

  const releaseGate = await readGate(projectId);
  if (!releaseGate.ok) {
    await holdAlike({ ...base, issueIds: waiting }, releaseGate.hold);
    return;
  }

  const reports = await readCriteria(projectId, waiting);
  if (!reports.ok) {
    await holdAlike({ ...base, issueIds: waiting }, reports.hold);
    return;
  }
  reportUncorroborated(projectId, reports.value);
  const held = reports.value.filter((r) => r.unearned.length > 0);
  const heldById = new Map(held.map((r) => [r.issueId, r]));
  const eligible = waiting.filter((id) => !heldById.has(id));
  result.issuesExcluded += held.length;
  if (held.length > 0) {
    reportHeldBack(projectId, held);
    await holdOnCriteria({ ...base, issueIds: held.map((r) => r.issueId) }, heldById);
  }

  if (eligible.length === 0) {
    logger.info(
      { projectId, excluded: held.length },
      'release-sweep: nothing eligible this tick — every waiting issue still owes a judging run ' +
        'on a criterion named above',
    );
    return;
  }

  if (!owner) {
    logger.error(
      { projectId },
      'release-sweep: no project owner to act as this tick — skipping, will try again next tick',
    );
    await holdAlike({ ...base, issueIds: eligible }, NO_ACTOR_HOLD);
    return;
  }

  const outcome = await cutWaitingRelease({ projectId, userId: owner, issueIds: eligible });
  // One release carries at most the oldest RELEASE_ROSTER_LIMIT; the rest were never sent.
  const named = new Set(outcome.named);
  const behind = eligible.filter((id) => !named.has(id));
  await holdAlike({ ...base, issueIds: behind }, queuedBehindHold(outcome.named.length));
  if (outcome.status === 'success') {
    result.projectsCut += 1;
    result.issuesCut += outcome.named.length;
    await clearReleaseHolds(outcome.named);
    logger.info(
      { projectId, cut: outcome.named.length, behind: behind.length, excluded: held.length },
      `release-sweep: ${outcome.output}`,
    );
    return;
  }
  const reasons = outcome.reasons ?? [outcome.error ?? outcome.output];
  if (outcome.status === 'failed') {
    logger.error({ projectId, err: outcome.error }, `release-sweep: ${outcome.output}`);
    const message = outcome.error ?? outcome.output;
    const claimed = await reportClaimedFailure(outcome.named, owner, message);
    const untouched = outcome.named.filter((id) => !claimed.includes(id));
    await holdAlike({ ...base, issueIds: untouched }, cutFailedHold(reasons));
    return;
  }
  logger.info({ projectId }, `release-sweep: ${outcome.output}`);
  const refused = refusalHold(outcome.code ?? 'RELEASE_CUT_REFUSED', reasons);
  await holdAlike({ ...base, issueIds: outcome.named }, refused);
}

export async function sweepAutomaticReleases(
  now: Date = new Date(),
  deps: ShippedEarlierDeps = {},
): Promise<AutomaticReleaseSweepResult> {
  const result: AutomaticReleaseSweepResult = {
    projectsCut: 0,
    issuesCut: 0,
    issuesExcluded: 0,
    holdsWritten: 0,
    shippedEarlier: 0,
  };
  await clearStaleReleaseHolds();
  const projectIds = await candidateProjectIds(now);
  for (const projectId of projectIds) {
    try {
      await sweepProject(projectId, result, now, deps);
    } catch (err) {
      logger.error(
        { err, projectId },
        'release-sweep: pass failed for this project — continuing with the rest',
      );
    }
  }
  return result;
}
