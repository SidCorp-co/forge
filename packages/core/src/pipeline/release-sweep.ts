// ISS-1117 — an issue at `awaiting_release` releases without a person acting, on a project
// whose release policy already leaves nobody an act (`autoProdDeploy` + a resolvable release
// gate) and whose waiting issue has every numbered acceptance criterion earned
// (`criteria-verdicts.ts`). Precedent: `runs-concluded.ts`'s own-tick noticing. The manual
// doors (`collectReleaseBlockers`, `forge advance`) are untouched; this only filters the
// unattended path. ISS-1215: every way it declines a waiting row is written on that row
// (`release-hold.ts`), never on the log alone.

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import { type IssueCriteriaReport, unearnedCriteriaReports } from '../issues/criteria-verdicts.js';
import { logger } from '../logger.js';
import {
  RELEASE_GATE_STATUS,
  ReleaseTargetUndeclaredError,
  resolveReleaseGate,
} from '../release-batch/gate.js';
import { loadCreatedBy } from '../schedules/release-batch-dispatch.js';
import { cutWaitingRelease } from '../schedules/release-batch-run.js';
import { projectAutoProdDeploy } from './release-coolify.js';
import {
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
  targetUndeclaredHold,
  writeReleaseHolds,
} from './release-hold.js';
import { advanceSweep, type SweepPosition, sweepWindow } from './sweep-cursor.js';

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
}

interface CandidateRow {
  id: string;
  project_id: string;
  cursor_ts: string;
}

// Projects with an unclaimed `awaiting_release` issue, via a bounded, resumable keyset page
// (`sweep-cursor.ts`) so a project stuck behind 200 others is reached within a few ticks.
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
       AND i.release_batch_run_id IS NULL
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

// `createReleaseBatch` claims issues and moves them to `releasing` in separate statements
// AFTER its own transaction, so a failure past that point (an enqueue error, say) can leave an
// issue claimed even though the attempt overall threw. An untouched row gets a hold
// (`cutFailedHold`); a claimed one is off the gate, so it is told here instead.
function claimedFailureBody(message: string, releaseBatchRunId: string | null): string {
  return [
    '**An automatic release attempt failed.**',
    '',
    `This issue was named in an automatic release sweep (ISS-1117) and the attempt did not go ` +
      `through: ${message}`,
    '',
    `This issue was already claimed into run ${releaseBatchRunId ?? '(unknown)'} before ` +
      'the attempt failed, so it will not be picked up again by this sweep — its status and ' +
      'claim need a person to look at them.',
  ].join('\n');
}

/** The rows a failed attempt claimed anyway, each told once per distinct message. */
async function reportClaimedFailure(
  issueIds: string[],
  authorId: string,
  message: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: issues.id, status: issues.status, releaseBatchRunId: issues.releaseBatchRunId })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const claimed = rows.filter(
    (r) => !(r.status === RELEASE_GATE_STATUS && r.releaseBatchRunId === null),
  );
  for (const row of claimed) {
    const body = claimedFailureBody(message, row.releaseBatchRunId);
    try {
      const existing = await db
        .select({ body: comments.body })
        .from(comments)
        .where(eq(comments.issueId, row.id));
      if (existing.some((c) => c.body === body)) continue;
      await db.insert(comments).values({ issueId: row.id, authorId, body });
    } catch (err) {
      logger.error({ err, issueId: row.id }, 'release-sweep: failed to post the failure comment');
    }
  }
  return claimed.map((r) => r.id);
}

/**
 * Every criterion holding an issue back, by number and by reason.
 *
 * A count says how many issues were left alone and names neither them nor what they owe, so an
 * issue that drops back a rung with no reason named is the same silence read from the other side.
 */
function reportHeldBack(projectId: string, held: readonly IssueCriteriaReport[]): void {
  for (const report of held) {
    logger.info(
      {
        projectId,
        issueId: report.issueId,
        criteria: report.unearned.map((c) => ({
          criterion: c.criterion,
          verdict: c.verdict,
          standing: c.standing,
          why: c.why,
        })),
      },
      `release-sweep: ${report.issueId} is held back on criterion ${report.unearned
        .map((c) => c.criterion)
        .join(', ')} — ${report.unearned.map((c) => `${c.criterion}: ${c.why}`).join('; ')}`,
    );
  }
}

/** Every issue waiting unclaimed at the gate on this project, oldest merge first. */
async function waitingIssueIds(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.status, RELEASE_GATE_STATUS),
        isNull(issues.releaseBatchRunId),
      ),
    )
    .orderBy(sql`${issues.mergedAt} ASC NULLS LAST`, asc(issues.id));
  return rows.map((r) => r.id);
}

interface HoldWrite {
  projectId: string;
  issueIds: string[];
  holdFor: (issueId: string) => ReleaseHold;
  authorId: string | null;
  now: Date;
  result: AutomaticReleaseSweepResult;
}

async function hold(write: HoldWrite): Promise<void> {
  const tally = await writeReleaseHolds(write);
  write.result.holdsWritten += tally.written;
  if (tally.written > 0) {
    logger.info(
      { projectId: write.projectId, written: tally.written, unchanged: tally.unchanged },
      'release-sweep: the reason these issues are held is written on each of them',
    );
  }
}

/** The gate, or the hold every waiting row gets because there is none to read. */
async function readGate(
  projectId: string,
): Promise<{ ok: true } | { ok: false; hold: ReleaseHold }> {
  try {
    const gate = await resolveReleaseGate(projectId);
    return gate ? { ok: true } : { ok: false, hold: NO_RELEASE_GATE_HOLD };
  } catch (err) {
    if (err instanceof ReleaseTargetUndeclaredError) {
      return { ok: false, hold: targetUndeclaredHold(err.message) };
    }
    logger.error({ err, projectId }, 'release-sweep: the release gate could not be read');
    return {
      ok: false,
      hold: gateUnreadableHold(err instanceof Error ? err.message : String(err)),
    };
  }
}

/** The criteria reports, or a hold naming why the verdicts could not be read. */
async function readCriteria(
  projectId: string,
  waiting: string[],
): Promise<{ ok: true; value: IssueCriteriaReport[] } | { ok: false; hold: ReleaseHold }> {
  try {
    return { ok: true, value: await unearnedCriteriaReports(waiting) };
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
): Promise<void> {
  if (!(await projectAutoProdDeploy(projectId))) {
    await clearProjectReleaseHolds(projectId);
    return;
  }

  const waiting = await waitingIssueIds(projectId);
  if (waiting.length === 0) return;
  const owner = (await loadCreatedBy(projectId)) ?? null;
  const base = { projectId, authorId: owner, now, result };

  const gate = await readGate(projectId);
  if (!gate.ok) {
    await hold({ ...base, issueIds: waiting, holdFor: () => gate.hold });
    return;
  }

  const reports = await readCriteria(projectId, waiting);
  if (!reports.ok) {
    await hold({ ...base, issueIds: waiting, holdFor: () => reports.hold });
    return;
  }
  const held = reports.value.filter((r) => r.unearned.length > 0);
  const heldById = new Map(held.map((r) => [r.issueId, r]));
  const eligible = waiting.filter((id) => !heldById.has(id));
  result.issuesExcluded += held.length;
  if (held.length > 0) {
    reportHeldBack(projectId, held);
    await hold({
      ...base,
      issueIds: held.map((r) => r.issueId),
      holdFor: (id) => criteriaHold(heldById.get(id) as IssueCriteriaReport),
    });
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
    await hold({ ...base, issueIds: eligible, holdFor: () => NO_ACTOR_HOLD });
    return;
  }

  const outcome = await cutWaitingRelease({ projectId, userId: owner, issueIds: eligible });
  // One release carries at most the oldest RELEASE_ROSTER_LIMIT; the rest were never sent.
  const named = new Set(outcome.named);
  const behind = eligible.filter((id) => !named.has(id));
  await hold({ ...base, issueIds: behind, holdFor: () => queuedBehindHold(outcome.named.length) });
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
    await hold({ ...base, issueIds: untouched, holdFor: () => cutFailedHold(reasons) });
    return;
  }
  logger.info({ projectId }, `release-sweep: ${outcome.output}`);
  const refused = refusalHold(outcome.code ?? 'RELEASE_CUT_REFUSED', reasons);
  await hold({ ...base, issueIds: outcome.named, holdFor: () => refused });
}

export async function sweepAutomaticReleases(
  now: Date = new Date(),
): Promise<AutomaticReleaseSweepResult> {
  const result: AutomaticReleaseSweepResult = {
    projectsCut: 0,
    issuesCut: 0,
    issuesExcluded: 0,
    holdsWritten: 0,
  };
  await clearStaleReleaseHolds();
  const projectIds = await candidateProjectIds(now);
  for (const projectId of projectIds) {
    try {
      await sweepProject(projectId, result, now);
    } catch (err) {
      logger.error(
        { err, projectId },
        'release-sweep: pass failed for this project — continuing with the rest',
      );
    }
  }
  return result;
}
