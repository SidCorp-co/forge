// ISS-1117 — an issue at `awaiting_release` releases without a person acting, on a project
// whose release policy already leaves nobody an act (`autoProdDeploy` + a resolvable release
// gate) and whose waiting issue has every numbered acceptance criterion earned
// (`criteria-verdicts.ts`). Precedent: `runs-concluded.ts`'s own-tick noticing. The manual
// doors (`collectReleaseBlockers`, `forge advance`) are untouched; this only filters the
// unattended path.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import { issuesWithUnearnedCriteria } from '../issues/criteria-verdicts.js';
import { logger } from '../logger.js';
import { resolveReleaseGate } from '../release-batch/gate.js';
import { loadReleaseRoster } from '../release-batch/queries.js';
import { loadCreatedBy } from '../schedules/release-batch-dispatch.js';
import { cutWaitingRelease } from '../schedules/release-batch-run.js';
import { projectAutoProdDeploy } from './release-coolify.js';
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

function sweepFailureBody(message: string): string {
  return [
    '**An automatic release attempt failed.**',
    '',
    `This issue was named in an automatic release sweep (ISS-1117) and the attempt did not go ` +
      `through: ${message}`,
    '',
    'This issue is unchanged: not claimed, not moved, no half-release. The next tick tries again ' +
      'on its own — nothing here needs a retry command. If this keeps recurring, the message above ' +
      'is what a person needs to look at.',
  ].join('\n');
}

// Names a genuine failed attempt on every issue it would have released, once per distinct
// message — an identical comment already there is not repeated.
async function reportSweepFailure(
  issueIds: string[],
  authorId: string,
  message: string,
): Promise<void> {
  const body = sweepFailureBody(message);
  for (const issueId of issueIds) {
    try {
      const existing = await db
        .select({ body: comments.body })
        .from(comments)
        .where(eq(comments.issueId, issueId));
      if (existing.some((c) => c.body === body)) continue;
      await db.insert(comments).values({ issueId, authorId, body });
    } catch (err) {
      logger.error({ err, issueId }, 'release-sweep: failed to post the failure comment');
    }
  }
}

async function sweepProject(projectId: string, result: AutomaticReleaseSweepResult): Promise<void> {
  if (!(await projectAutoProdDeploy(projectId))) return;

  const gate = await resolveReleaseGate(projectId).catch(() => null);
  if (!gate) return;

  const roster = await loadReleaseRoster(projectId);
  const waiting = roster.issues.filter((i) => i.claimedByRunId === null).map((i) => i.id);
  if (waiting.length === 0) return;

  const unearned = await issuesWithUnearnedCriteria(waiting);
  const unearnedSet = new Set(unearned);
  const eligible = waiting.filter((id) => !unearnedSet.has(id));
  result.issuesExcluded += unearned.length;

  if (eligible.length === 0) {
    logger.info(
      { projectId, excluded: unearned.length },
      'release-sweep: nothing eligible this tick — every waiting issue still owes a judging run ' +
        'on a skipped, failed or unjudged criterion',
    );
    return;
  }

  const userId = await loadCreatedBy(projectId);
  if (!userId) {
    logger.error(
      { projectId },
      'release-sweep: no project owner to act as this tick — skipping, will try again next tick',
    );
    return;
  }

  const outcome = await cutWaitingRelease({ projectId, userId, issueIds: eligible });
  if (outcome.status === 'success') {
    result.projectsCut += 1;
    result.issuesCut += eligible.length;
    logger.info(
      { projectId, cut: eligible.length, excluded: unearned.length },
      `release-sweep: ${outcome.output}`,
    );
    return;
  }
  if (outcome.status === 'failed') {
    logger.error({ projectId, err: outcome.error }, `release-sweep: ${outcome.output}`);
    await reportSweepFailure(eligible, userId, outcome.error ?? outcome.output);
    return;
  }
  logger.info({ projectId }, `release-sweep: ${outcome.output}`);
}

export async function sweepAutomaticReleases(
  now: Date = new Date(),
): Promise<AutomaticReleaseSweepResult> {
  const result: AutomaticReleaseSweepResult = { projectsCut: 0, issuesCut: 0, issuesExcluded: 0 };
  const projectIds = await candidateProjectIds(now);
  for (const projectId of projectIds) {
    try {
      await sweepProject(projectId, result);
    } catch (err) {
      logger.error(
        { err, projectId },
        'release-sweep: pass failed for this project — continuing with the rest',
      );
    }
  }
  return result;
}
