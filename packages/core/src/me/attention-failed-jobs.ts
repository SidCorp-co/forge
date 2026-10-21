/**
 * The attention read's failed jobs, one row per issue, and what an answer the reader owes says of
 * its issue's failed job instead (ISS-1229 r15, the master's ruling).
 */

import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  not,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { issues, jobs, projects } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';
import { issueArchiveSide } from '../issues/archive.js';
import { ISSUE_RESOLVED_STATUSES, ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import { LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import {
  type AttentionFailedJobRow,
  type AttentionScope,
  BUCKET_CAPS,
  type BucketLimit,
  capped,
  inScope,
  isNot,
  needsReviewWhere,
  owedAnswerWhere,
} from './attention-buckets.js';

const retryJobs = alias(jobs, 'retry_jobs');
const laterJob = alias(jobs, 'later_failed_job');
const liveJob = alias(jobs, 'live_job_of_its_kind');
const answeredAsk = alias(agentQuestions, 'answered_ask_of_job');

/** A job that stopped on a question a person has since answered: the answer hands its issue back to
 *  the masters, so the stop is no failure of anyone's (ISS-1228 round 24). */
function stoppedOnAnsweredQuestion(job: typeof jobs | typeof laterJob): SQL {
  return and(
    sql`coalesce(${job.failureReason}, '') = 'stopped_on_question'`,
    exists(
      db
        .select({ one: sql`1` })
        .from(answeredAsk)
        .where(
          and(
            eq(answeredAsk.agentSessionId, job.agentSessionId),
            eq(answeredAsk.status, 'answered'),
            sql`${answeredAsk.createdAt} >= ${job.createdAt}`,
          ),
        ),
    ),
  ) as SQL;
}

/**
 * A failed job of the caller's that nothing retried, from the last week: the part read off `jobs`.
 * Live work of its kind on its issue is its retry already, which the retry route refuses to add to,
 * so a row offering one would offer a button that never works (ISS-1229 r17).
 */
export function failedJobOwnWhere(userId: string, job: typeof jobs | typeof laterJob = jobs): SQL {
  return and(
    eq(job.createdBy, userId),
    eq(job.status, 'failed'),
    sql`${job.createdAt} >= now() - interval '7 days'`,
    not(stoppedOnAnsweredQuestion(job)),
    notExists(db.select({ one: sql`1` }).from(retryJobs).where(eq(retryJobs.retryOf, job.id))),
    notExists(
      db
        .select({ one: sql`1` })
        .from(liveJob)
        .where(
          and(
            eq(liveJob.issueId, job.issueId),
            eq(liveJob.type, job.type),
            inArray(liveJob.status, [...LIVE_JOB_STATUSES]),
          ),
        ),
    ),
  ) as SQL;
}

/** A later failed job of the caller's on the same issue: then that one is the issue's row, not this. */
function laterFailureOnItsIssue(userId: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(laterJob)
      .where(
        and(
          eq(laterJob.issueId, jobs.issueId),
          failedJobOwnWhere(userId, laterJob),
          sql`(coalesce(${laterJob.finishedAt}, ${laterJob.createdAt}), ${laterJob.id})
            > (coalesce(${jobs.finishedAt}, ${jobs.createdAt}), ${jobs.id})`,
        ),
      ),
  );
}

/**
 * One issue, one row (ISS-1229 r15, the master's ruling): an answer the reader owes outranks a failed
 * job, which outranks a stuck reason. An issue the reader owes an answer or a review is listed as that,
 * naming its failed job under it, so its failed job is not listed again.
 */
function outrankedByAnOwedAnswer(userId: string): SQL {
  return or(owedAnswerWhere(userId), needsReviewWhere(userId)) as SQL;
}

/** The `issues` row in scope is listed as the caller's failed job: what a stuck count leaves it out of. */
export function heldAsFailedJobWhere(userId: string): SQL {
  return and(
    failedJobIssueWhere(),
    isNot(outrankedByAnOwedAnswer(userId)),
    exists(
      db
        .select({ one: sql`1` })
        .from(jobs)
        .where(and(eq(jobs.issueId, issues.id), failedJobOwnWhere(userId))),
    ),
  ) as SQL;
}

/**
 * An issue the job ran for that is still open and not archived; a job on no issue is listed too. A
 * dropped issue is finished as surely as a closed one: its failure asks nobody to retry it (ISS-1229 r16).
 */
export function failedJobIssueWhere(): SQL {
  return and(
    notInArray(issues.status, [...ISSUE_RESOLVED_STATUSES, ...ISSUE_TERMINAL_STATUSES]),
    ...issueArchiveSide(false),
  ) as SQL;
}

/** Each issue once, by its latest failed job, and none an answer the reader owes lists instead. */
export function failedJobsWhere(userId: string): SQL {
  return and(
    failedJobOwnWhere(userId),
    or(
      isNull(issues.id),
      and(
        failedJobIssueWhere(),
        isNot(outrankedByAnOwedAnswer(userId)),
        not(laterFailureOnItsIssue(userId)),
      ),
    ),
  ) as SQL;
}

export interface StandingFailure {
  type: string;
  error: string | null;
  failureReason: string | null;
}

/** The caller's latest failed job on each of these issues, which a row owed an answer names under it. */
export async function selectStandingFailures(
  userId: string,
  issueIds: readonly string[],
): Promise<Map<string, StandingFailure>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([jobs.issueId], {
      issueId: jobs.issueId,
      type: jobs.type,
      error: jobs.error,
      failureReason: jobs.failureReason,
    })
    .from(jobs)
    .where(and(inArray(jobs.issueId, [...issueIds]), failedJobOwnWhere(userId)))
    .orderBy(
      jobs.issueId,
      desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`),
      desc(jobs.id),
    );
  return new Map(rows.flatMap((r) => (r.issueId ? [[r.issueId, r] as const] : [])));
}

export function selectFailedJobs(
  userId: string,
  scope: AttentionScope = {},
  limit: BucketLimit = BUCKET_CAPS.failedJobs,
): Promise<AttentionFailedJobRow[]> {
  return capped(
    db
      .select({
        jobId: jobs.id,
        type: jobs.type,
        finishedAt: jobs.finishedAt,
        createdAt: jobs.createdAt,
        error: jobs.error,
        failureReason: jobs.failureReason,
        issueDocId: issues.id,
        issueTitle: issues.title,
        issSeq: issues.issSeq,
        issuePrefix: projects.issuePrefix,
        projectSlug: projects.slug,
        projectName: projects.name,
      })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .leftJoin(issues, eq(issues.id, jobs.issueId))
      .where(and(failedJobsWhere(userId), inScope(scope)))
      .orderBy(desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`))
      .$dynamic(),
    limit,
  ) as unknown as Promise<AttentionFailedJobRow[]>;
}
