// What may enter `draft`, and why a draft write that lost its race was refused (ISS-787). Moved out
// of the transition writer whole; the writer calls both.

import { count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, jobs, pipelineRuns } from '../db/schema.js';
import { logger } from '../logger.js';
import { statusForCaller } from './status-sets.js';
import { TransitionError } from './transition-error.js';

/**
 * ISS-787 — `draft` is the safe entry status you get only by asking for it, and
 * `open` auto-triages and spawns a run, which left three agents no way back. So
 * `draft` is reachable, but only while nothing has run: a run or a job means
 * work exists, and demoting would make the status claim it never started.
 */
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
      'Draft (draft) is reachable only while the issue has never entered the pipeline, and that could not be checked just now. Retry, or use On hold (on_hold) to pause active work.',
      { checkFailed: true },
    );
  }

  const { runCount, jobCount } = counts;
  if (runCount === 0 && jobCount === 0) return;
  return refuse(
    `Draft (draft) is reachable only while the issue has never entered the pipeline; this one has ${runCount} pipeline run(s) and ${jobCount} job(s). Use On hold (on_hold) to pause active work, or Dropped (dropped) to abandon it.`,
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
      `issue status changed concurrently — it left ${statusForCaller(fromStatus)} for ${statusForCaller(row.status)} while this transition was being applied`,
      { ...details, observedStatus: row.status },
    );
  }
  if (counts && (counts.runCount > 0 || counts.jobCount > 0)) {
    return new TransitionError(
      'ILLEGAL_TRANSITION',
      `Draft (draft) is reachable only while the issue has never entered the pipeline, and it acquired ${counts.runCount} pipeline run(s) and ${counts.jobCount} job(s) while this transition was being applied. Use On hold (on_hold) to pause active work.`,
      { ...details, runCount: counts.runCount, jobCount: counts.jobCount },
    );
  }
  return new TransitionError(
    'ILLEGAL_TRANSITION',
    `the Draft (draft) transition from ${statusForCaller(fromStatus)} did not apply, and re-reading found neither a status change nor a pipeline run/job to attribute it to. Retry; if it refuses again, use On hold (on_hold) to pause active work.`,
    { ...details, attributable: false },
  );
}
