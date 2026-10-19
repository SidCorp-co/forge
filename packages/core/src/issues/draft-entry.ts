// What may enter `draft`, and why a draft write that lost its race was refused (ISS-787). Moved out
// of the transition writer whole; the writer calls both.

import { count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, jobs, pipelineRuns } from '../db/schema.js';
import { logger } from '../logger.js';
import { DRAFT_EXIT_TARGETS } from '../pipeline/state-machine.js';
import { statusLabel } from './status-sets.js';
import { TransitionError } from './transition-error.js';

/**
 * ISS-787 — `draft` is the safe entry status you get only by asking for it, and
 * `open` auto-triages and spawns a run, which left three agents no way back. So
 * `draft` is reachable, but only while nothing has run: a run or a job means
 * work exists, and demoting would make the status claim it never started.
 */
// Every refusal here is read on the status menu, so a status is named by its label alone; the
// values a caller sends back stay in the refusal's details (ISS-1421 r12).
const DRAFT_ONLY_UNRUN = 'An issue goes back to Draft only if it never entered the pipeline.';

const counted = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function runsAndJobs(runCount: number, jobCount: number): string {
  return `${counted(runCount, 'pipeline run')} and ${counted(jobCount, 'job')}`;
}

/** "Open, Closed or Dropped". */
function listedOr(statuses: readonly string[]): string {
  const labels = statuses.map(statusLabel);
  return labels.length < 2
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

/** Why a Draft issue cannot move to `to`, which is not one of Draft's exits. */
export function draftExitRefusal(to: string): string {
  return `A Draft issue can move only to ${listedOr(DRAFT_EXIT_TARGETS)}, not to ${statusLabel(to)}. Promote it to Open first, or use Dropped to discard it.`;
}

/** `null` when the counts could not be read — callers must treat that as "refuse". */
async function countRunsAndJobs(
  issueId: string,
): Promise<{ runCount: number; jobCount: number } | null> {
  try {
    const [[runRow], [jobRow]] = await Promise.all([
      db
        .select({ n: count() })
        .from(pipelineRuns)
        .where(eq(pipelineRuns.issueId, issueId))
        .limit(1),
      db.select({ n: count() }).from(jobs).where(eq(jobs.issueId, issueId)).limit(1),
    ]);
    return { runCount: Number(runRow?.n ?? 0), jobCount: Number(jobRow?.n ?? 0) };
  } catch (err) {
    logger.warn({ err, issueId }, 'draft-exemption check failed; refusing the transition');
    return null;
  }
}

export async function assertIssueNeverEnteredPipeline(
  issueId: string,
  fromStatus: IssueStatus,
): Promise<void> {
  const refuse = (detail: string, details: Record<string, unknown>): never => {
    throw new TransitionError('ILLEGAL_TRANSITION', detail, {
      from: fromStatus,
      to: 'draft',
      ...details,
    });
  };

  const counts = await countRunsAndJobs(issueId);
  if (!counts) {
    return refuse(
      `${DRAFT_ONLY_UNRUN} That could not be checked just now. Retry, or use On hold to pause active work.`,
      { checkFailed: true },
    );
  }

  const { runCount, jobCount } = counts;
  if (runCount === 0 && jobCount === 0) return;
  return refuse(
    `${DRAFT_ONLY_UNRUN} This one has ${runsAndJobs(runCount, jobCount)}. Use On hold to pause active work, or Dropped to abandon it.`,
    { runCount, jobCount },
  );
}

/** Two conditions share the `draft` UPDATE's WHERE — the status still `fromStatus`, the never-ran
 *  counts still zero — so a zero-row result does not say which bit. Re-read both and name it. */
export async function explainDraftRace(
  issueId: string,
  fromStatus: IssueStatus,
  toStatus: IssueStatus,
): Promise<TransitionError> {
  const details = { from: fromStatus, to: toStatus, raced: true };
  const [[row], counts] = await Promise.all([
    db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).limit(1),
    countRunsAndJobs(issueId),
  ]);
  if (row && row.status !== fromStatus) {
    return new TransitionError(
      'STALE_TRANSITION',
      `The issue moved from ${statusLabel(fromStatus)} to ${statusLabel(row.status)} while this move was being applied.`,
      { ...details, observedStatus: row.status },
    );
  }
  if (counts && (counts.runCount > 0 || counts.jobCount > 0)) {
    return new TransitionError(
      'ILLEGAL_TRANSITION',
      `${DRAFT_ONLY_UNRUN} It gained ${runsAndJobs(counts.runCount, counts.jobCount)} while this move was being applied. Use On hold to pause active work.`,
      { ...details, runCount: counts.runCount, jobCount: counts.jobCount },
    );
  }
  return new TransitionError(
    'ILLEGAL_TRANSITION',
    `The move from ${statusLabel(fromStatus)} to Draft did not apply, and nothing read since explains why. Retry, and if it is refused again, use On hold to pause active work.`,
    { ...details, attributable: false },
  );
}
