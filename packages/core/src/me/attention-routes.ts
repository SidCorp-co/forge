import { and, desc, eq, inArray, isNull, notExists, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import {
  comments,
  commentMentions,
  issues,
  jobs,
  notifications,
  projects,
} from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

type AttentionKind = 'needs_review' | 'awaiting_input' | 'mention' | 'failed_job';

interface AttentionItem {
  kind: AttentionKind;
  title: string;
  link: string;
  since: string;
  issueRef?: string;
  status?: string;
  projectSlug?: string;
  projectName?: string;
}

interface AttentionResponse {
  needsReview: AttentionItem[];
  awaitingInput: AttentionItem[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  total: number;
}

/**
 * Bucket criteria for `GET /me/attention` (ISS-665 — keep this comment in sync
 * with the WHERE clauses below; it is the single place documenting why an item
 * is/isn't "needs attention"):
 *
 * - `needsReview`    — issues assigned to the caller sitting in a status that
 *   needs the caller's action (`developed` awaiting review, `reopen` awaiting
 *   a fix). Self-clearing: driven by live `issues.status`.
 * - `awaitingInput`  — issues assigned to the caller blocked on a human
 *   (`waiting`, `needs_info`, `on_hold`). Self-clearing: live `issues.status`.
 * - `mentions`       — unread `@mention` notifications for the caller.
 *   Self-clearing: driven by `notifications.read`.
 * - `failedJobs`     — jobs the caller triggered that failed in the trailing
 *   7 days, EXCLUDING:
 *     1. superseded attempts — any job with a later retry (`jobs.retryOf`
 *        points back at it). `jobs/retry.ts` inserts every retry as a NEW row
 *        and leaves the original `status='failed'` forever, so without this
 *        exclusion a resolved-by-retry failure keeps reporting itself for up
 *        to 7 days. The LATEST attempt in a chain has no retry pointing at
 *        it, so it still surfaces if it is itself still failed.
 *     2. jobs whose linked issue has already reached a terminal state
 *        (`closed`, `released`) — the problem was resolved by hand even
 *        though the job row itself stays `failed`. Jobs with no linked issue
 *        (PM/system/deploy jobs) are NOT excluded by this rule.
 */
const NEEDS_REVIEW_STATUSES = ['developed', 'reopen'] as const;
const AWAITING_INPUT_STATUSES = ['waiting', 'needs_info', 'on_hold'] as const;
const FAILED_JOB_RESOLVED_ISSUE_STATUSES = ['closed', 'released'] as const;
const PER_BUCKET = 5;

// Self-join alias for the retry-chain exclusion (a job and its retry are both
// rows in `jobs`; drizzle requires an alias to reference the table twice).
const retryJobs = alias(jobs, 'retry_jobs');

export const meAttentionRoutes = new Hono<{ Variables: AuthVars }>();
meAttentionRoutes.use('/attention', requireAuth(), assertEmailVerified());

meAttentionRoutes.get('/attention', async (c) => {
  const userId = c.get('userId');

  const [needsReviewRows, awaitingInputRows, mentionRows, failedJobRows] = await Promise.all([
    db
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
        projectSlug: projects.slug,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          eq(issues.assigneeId, userId),
          inArray(issues.status, [...NEEDS_REVIEW_STATUSES]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(PER_BUCKET),

    db
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
        projectSlug: projects.slug,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          eq(issues.assigneeId, userId),
          inArray(issues.status, [...AWAITING_INPUT_STATUSES]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(PER_BUCKET),

    db
      .select({
        notificationId: notifications.id,
        notificationTitle: notifications.title,
        mentionedAt: commentMentions.createdAt,
        issueDocId: issues.id,
        issSeq: issues.issSeq,
        projectSlug: projects.slug,
        projectName: projects.name,
      })
      .from(commentMentions)
      .innerJoin(comments, eq(comments.id, commentMentions.commentId))
      .innerJoin(issues, eq(issues.id, comments.issueId))
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .leftJoin(
        notifications,
        and(
          eq(notifications.userId, commentMentions.userId),
          eq(notifications.type, 'mention'),
          eq(notifications.issueId, comments.issueId),
        ),
      )
      .where(
        and(
          eq(commentMentions.userId, userId),
          // Surface only mentions whose corresponding notification is unread,
          // OR mentions with no notification row (older comments before the
          // notify-mentions subscriber landed).
          sql`(${notifications.read} IS NULL OR ${notifications.read} = false)`,
        ),
      )
      .orderBy(desc(commentMentions.createdAt))
      .limit(PER_BUCKET),

    db
      .select({
        id: jobs.id,
        type: jobs.type,
        finishedAt: jobs.finishedAt,
        createdAt: jobs.createdAt,
        error: jobs.error,
        issueDocId: issues.id,
        issSeq: issues.issSeq,
        projectSlug: projects.slug,
        projectName: projects.name,
      })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .leftJoin(issues, eq(issues.id, jobs.issueId))
      .where(
        and(
          eq(jobs.createdBy, userId),
          eq(jobs.status, 'failed'),
          sql`${jobs.createdAt} >= now() - interval '7 days'`,
          // Exclusion 1: drop every superseded attempt in a retry chain — see
          // the criteria doc above.
          notExists(
            db
              .select({ one: sql`1` })
              .from(retryJobs)
              .where(eq(retryJobs.retryOf, jobs.id)),
          ),
          // Exclusion 2: drop failures whose linked issue already moved on;
          // null-issue jobs (no `jobs.issueId`) are kept.
          or(isNull(issues.id), notInArray(issues.status, [...FAILED_JOB_RESOLVED_ISSUE_STATUSES])),
        ),
      )
      .orderBy(desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`))
      .limit(PER_BUCKET),
  ]);

  const issueLink = (slug: string, docId: string) => `/projects/${slug}/issues/${docId}`;

  const needsReview: AttentionItem[] = needsReviewRows.map((r) => ({
    kind: 'needs_review',
    title: r.title,
    link: issueLink(r.projectSlug, r.id),
    since: r.updatedAt.toISOString(),
    issueRef: `ISS-${r.issSeq}`,
    status: r.status,
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  }));

  const awaitingInput: AttentionItem[] = awaitingInputRows.map((r) => ({
    kind: 'awaiting_input',
    title: r.title,
    link: issueLink(r.projectSlug, r.id),
    since: r.updatedAt.toISOString(),
    issueRef: `ISS-${r.issSeq}`,
    status: r.status,
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  }));

  const mentions: AttentionItem[] = mentionRows.map((r) => ({
    kind: 'mention',
    title: r.notificationTitle ?? `Mention in ISS-${r.issSeq}`,
    link: issueLink(r.projectSlug, r.issueDocId),
    since: r.mentionedAt.toISOString(),
    issueRef: `ISS-${r.issSeq}`,
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  }));

  const failedJobs: AttentionItem[] = failedJobRows.map((r) => {
    const item: AttentionItem = {
      kind: 'failed_job',
      title: r.error ? `${r.type} failed: ${r.error.slice(0, 80)}` : `${r.type} job failed`,
      link: r.issueDocId ? issueLink(r.projectSlug, r.issueDocId) : `/projects/${r.projectSlug}`,
      since: (r.finishedAt ?? r.createdAt).toISOString(),
      status: 'failed',
      projectSlug: r.projectSlug,
      projectName: r.projectName,
    };
    if (r.issSeq != null) item.issueRef = `ISS-${r.issSeq}`;
    return item;
  });

  const response: AttentionResponse = {
    needsReview,
    awaitingInput,
    mentions,
    failedJobs,
    total: needsReview.length + awaitingInput.length + mentions.length + failedJobs.length,
  };

  return c.json(response);
});
