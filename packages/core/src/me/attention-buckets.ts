import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import {
  commentMentions,
  comments,
  issues,
  jobs,
  notificationDeliveries,
  notificationDeliveryMembers,
  notifications,
  organizationMembers,
  projectMembers,
  projects,
  reconcileRuns,
} from '../db/schema.js';
import { issueArchiveSide } from '../issues/archive.js';
import { creatorIsAgentCondition } from '../issues/creator.js';
import { statusEnteredAtSql } from '../issues/status-entered-at.js';
import { AWAITING_INPUT_STATUSES, ISSUE_RESOLVED_STATUSES } from '../issues/status-sets.js';
import { statusesInWorkState } from '../issues/work-state.js';
import { visibleProjectsWhere } from '../lib/authz.js';
import { holdsOpenHumanQuestion } from '../questions/issue-coupling.js';

export const NEEDS_REVIEW_STATUSES = ['developed', 'reopen'] as const;

/** The six buckets the attention read lists, by their response keys. */
export const ATTENTION_BUCKETS = [
  'needsReview',
  'awaitingInput',
  'mentions',
  'failedJobs',
  'pendingSkillUpdates',
  'unseenDrafts',
] as const;
export type AttentionBucket = (typeof ATTENTION_BUCKETS)[number];

/** How many rows each bucket lists unless the caller asks for it whole. */
export const BUCKET_CAPS: Readonly<Record<AttentionBucket, number>> = {
  needsReview: 5,
  awaitingInput: 20,
  mentions: 5,
  failedJobs: 5,
  pendingSkillUpdates: 20,
  unseenDrafts: 20,
};

export const UNSEEN_DRAFTS_CAP = BUCKET_CAPS.unseenDrafts;

export const AWAITING_INPUT_CAP = BUCKET_CAPS.awaitingInput;

/** A bucket's cap, or `null` where the caller asked for it whole (ISS-1229 r14). */
export type BucketLimit = number | null;

function capped<T extends { limit: (n: number) => unknown }>(query: T, limit: BucketLimit) {
  return limit === null ? query : query.limit(limit);
}

/** Which organisation's projects a read covers; none named reads every one the caller can see. */
export interface AttentionScope {
  orgId?: string | undefined;
}

/**
 * Applied before each cap, so a cap filled by one organisation cannot empty another (ISS-1229 r13).
 * An archived project's page answers not found, so nothing of it is counted or listed (ISS-1229 r15).
 */
export function inScope(scope: AttentionScope): SQL {
  return and(
    isNull(projects.archivedAt),
    scope.orgId ? eq(projects.orgId, scope.orgId) : undefined,
  ) as SQL;
}

const retryJobs = alias(jobs, 'retry_jobs');

export interface AttentionIssueRow {
  id: string;
  issSeq: number;
  issuePrefix: string | null;
  title: string;
  status: string;
  /** When it entered its status: what the item's age counts from, never the last write (ISS-1229 r8). */
  statusEnteredAt: Date;
  projectSlug: string;
  projectName: string;
}

/** The awaiting-input row, which carries WHY it is ranked where it is. */
export interface AttentionAwaitingRow extends AttentionIssueRow {
  /** Since its oldest open question to a person, or since it entered its status where none is open. */
  waitingSince: Date;
  claimsHeld: number;
  workspacesPinned: number;
  dependents: number;
  blockerKind: string | null;
  questionId: string | null;
}

export interface AttentionMentionRow {
  notificationTitle: string | null;
  mentionedAt: Date;
  issueDocId: string;
  issSeq: number;
  issuePrefix: string | null;
  projectSlug: string;
  projectName: string;
}

export interface AttentionFailedJobRow {
  type: string;
  finishedAt: Date | null;
  createdAt: Date;
  error: string | null;
  /** What the failure classifier named, where it named anything. */
  failureReason: string | null;
  issueDocId: string | null;
  issueTitle: string | null;
  issSeq: number | null;
  issuePrefix: string | null;
  projectSlug: string;
  projectName: string;
}

export interface AttentionReconcileRow {
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  projectSlug: string;
  projectName: string;
}

export function ownedForAnswer(userId: string) {
  return or(
    eq(issues.assigneeId, userId),
    and(isNull(issues.assigneeId), eq(issues.createdById, userId)),
  );
}

/** Negated where a predicate can read NULL: a NULL there is "not held", never "unknown". */
export function isNot(condition: SQL): SQL {
  return sql`NOT coalesce((${condition}), false)`;
}

const statusEnteredAt = statusEnteredAtSql({
  id: sql`${issues.id}`,
  status: sql`${issues.status}`,
  createdAt: sql`${issues.createdAt}`,
});

const issueFields = {
  id: issues.id,
  issSeq: issues.issSeq,
  issuePrefix: projects.issuePrefix,
  title: issues.title,
  status: issues.status,
  statusEnteredAt: sql<Date>`${statusEnteredAt}`.mapWith(issues.createdAt),
  projectSlug: projects.slug,
  projectName: projects.name,
} as const;

export function needsReviewWhere(userId: string): SQL {
  return and(
    eq(issues.assigneeId, userId),
    inArray(issues.status, [...NEEDS_REVIEW_STATUSES]),
    // A person owes it an answer, so it is counted once, as awaiting input.
    sql`not ${holdsOpenHumanQuestion(issues.id)}`,
  ) as SQL;
}

export function selectNeedsReview(
  userId: string,
  scope: AttentionScope = {},
  limit: BucketLimit = BUCKET_CAPS.needsReview,
): Promise<AttentionIssueRow[]> {
  return capped(
    db
      .select(issueFields)
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(and(needsReviewWhere(userId), inScope(scope)))
      .orderBy(desc(issues.updatedAt))
      .$dynamic(),
    limit,
  ) as unknown as Promise<AttentionIssueRow[]>;
}

function openQuestionCost(column: string): SQL<number> {
  return sql<number>`coalesce((select sum(q.${sql.raw(column)}) from agent_questions q
    where q.issue_id = issues.id and q.project_id = issues.project_id
      and q.status = 'open'), 0)::int`;
}

const AWAITING_COST_ORDER = [
  desc(openQuestionCost('claims_held')),
  desc(openQuestionCost('workspaces_pinned')),
  desc(openQuestionCost('dependents')),
  issues.updatedAt,
] as const;

/** A park the reader owes an answer to, in any project; `awaitingInputWhere` adds what they can see. */
export function owedAnswerWhere(userId: string): SQL {
  return and(
    ownedForAnswer(userId),
    or(
      inArray(issues.status, [...AWAITING_INPUT_STATUSES]),
      // A question left on a draft, closed or dropped issue is not something to act on.
      and(
        notInArray(issues.status, [
          ...statusesInWorkState('draft'),
          ...statusesInWorkState('finished'),
        ]),
        holdsOpenHumanQuestion(issues.id),
      ),
    ),
  ) as SQL;
}

export function awaitingInputWhere(userId: string): SQL {
  return and(owedAnswerWhere(userId), ...visibleProjectsWhere()) as SQL;
}

/** The caller's memberships, which `visibleProjectsWhere` reads, joined beside `projects`. */
export const memberOf = (userId: string) =>
  and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId));
export const orgMemberOf = (userId: string) =>
  and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId));

export function selectAwaitingInput(
  userId: string,
  scope: AttentionScope = {},
  limit: BucketLimit = BUCKET_CAPS.awaitingInput,
): Promise<AttentionAwaitingRow[]> {
  return capped(
    db
      .select({
        ...issueFields,
        waitingSince: sql<Date>`coalesce((select min(q.created_at) from agent_questions q
        where q.issue_id = ${issues.id} and q.status = 'open' and q.blocker_kind = 'human'),
        ${statusEnteredAt})`.mapWith(issues.createdAt),
        claimsHeld: openQuestionCost('claims_held'),
        workspacesPinned: openQuestionCost('workspaces_pinned'),
        dependents: openQuestionCost('dependents'),
        blockerKind: openQuestionColumn('blocker_kind'),
        questionId: openQuestionColumn('id'),
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .leftJoin(projectMembers, memberOf(userId))
      .leftJoin(organizationMembers, orgMemberOf(userId))
      .where(and(awaitingInputWhere(userId), inScope(scope)))
      .orderBy(...AWAITING_COST_ORDER)
      .$dynamic(),
    limit,
  ) as unknown as Promise<AttentionAwaitingRow[]>;
}

function openQuestionColumn(column: string): SQL<string | null> {
  return sql<string | null>`(select q.${sql.raw(column)} from agent_questions q
    where q.issue_id = issues.id and q.project_id = issues.project_id
      and q.status = 'open'
    order by q.created_at desc, q.id desc limit 1)`;
}

function adminsProject(userId: string) {
  return or(
    exists(
      db
        .select({ one: sql`1` })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projects.id),
            eq(projectMembers.userId, userId),
            eq(projectMembers.role, 'admin'),
          ),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, projects.orgId),
            eq(organizationMembers.userId, userId),
            inArray(organizationMembers.role, ['owner', 'admin']),
          ),
        ),
    ),
  );
}

function unseenDraftOwner(userId: string): SQL {
  return or(
    eq(issues.assigneeId, userId),
    and(isNull(issues.assigneeId), or(eq(issues.createdById, userId), adminsProject(userId))),
  ) as SQL;
}

export function unseenDraftCondition(userId: string): SQL {
  return and(
    eq(issues.status, 'draft'),
    creatorIsAgentCondition(),
    unseenDraftOwner(userId),
    notExists(
      db
        .select({ one: sql`1` })
        .from(comments)
        .where(and(eq(comments.issueId, issues.id), isNull(comments.authorDeviceId))),
    ),
  ) as SQL;
}

const PRIORITY_RANK = sql`case ${issues.priority} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;

export function selectUnseenDrafts(
  userId: string,
  scope: AttentionScope = {},
  limit: BucketLimit = BUCKET_CAPS.unseenDrafts,
): Promise<AttentionIssueRow[]> {
  return capped(
    db
      .select(issueFields)
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(and(unseenDraftCondition(userId), inScope(scope)))
      .orderBy(PRIORITY_RANK, desc(issues.updatedAt))
      .$dynamic(),
    limit,
  ) as unknown as Promise<AttentionIssueRow[]>;
}

const mentionFields = {
  notificationTitle: notifications.title,
  mentionedAt: commentMentions.createdAt,
  issueDocId: issues.id,
  issSeq: issues.issSeq,
  issuePrefix: projects.issuePrefix,
  projectSlug: projects.slug,
  projectName: projects.name,
};

/** The mentions bucket's rows, under whichever fields the caller selects: its list and its count. */
export function mentionsOf<F extends Record<string, unknown>>(
  fields: F,
  userId: string,
  scope: AttentionScope,
) {
  return db
    .select(fields as never)
    .from(commentMentions)
    .innerJoin(comments, eq(comments.id, commentMentions.commentId))
    .innerJoin(issues, and(eq(issues.id, comments.issueId), ...issueArchiveSide(false)))
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .leftJoin(
      notifications,
      and(
        eq(notifications.type, 'mention'),
        eq(notifications.issueId, comments.issueId),
        sql`EXISTS (
            SELECT 1
              FROM ${notificationDeliveryMembers} dm
              JOIN ${notificationDeliveries} dd ON dd.id = dm.delivery_id
             WHERE dm.notification_id = ${notifications.id}
               AND dd.user_id = ${commentMentions.userId}
          )`,
      ),
    )
    .leftJoin(
      notificationDeliveryMembers,
      eq(notificationDeliveryMembers.notificationId, notifications.id),
    )
    .leftJoin(
      notificationDeliveries,
      and(
        eq(notificationDeliveries.id, notificationDeliveryMembers.deliveryId),
        eq(notificationDeliveries.userId, commentMentions.userId),
      ),
    )
    .where(
      and(
        eq(commentMentions.userId, userId),
        sql`${notificationDeliveries.readAt} IS NULL`,
        inScope(scope),
      ),
    )
    .$dynamic();
}

export function selectMentions(
  userId: string,
  scope: AttentionScope = {},
  limit: BucketLimit = BUCKET_CAPS.mentions,
): Promise<AttentionMentionRow[]> {
  return capped(
    mentionsOf(mentionFields, userId, scope).orderBy(desc(commentMentions.createdAt)),
    limit,
  ) as unknown as Promise<AttentionMentionRow[]>;
}

/** A failed job of the caller's that nothing retried, from the last week: the part read off `jobs`. */
export function failedJobOwnWhere(userId: string): SQL {
  return and(
    eq(jobs.createdBy, userId),
    eq(jobs.status, 'failed'),
    sql`${jobs.createdAt} >= now() - interval '7 days'`,
    notExists(db.select({ one: sql`1` }).from(retryJobs).where(eq(retryJobs.retryOf, jobs.id))),
  ) as SQL;
}

/** An issue the job ran for that is still open and not archived; a job on no issue is listed too. */
export function failedJobIssueWhere(): SQL {
  return and(
    notInArray(issues.status, [...ISSUE_RESOLVED_STATUSES]),
    ...issueArchiveSide(false),
  ) as SQL;
}

export function failedJobsWhere(userId: string): SQL {
  return and(failedJobOwnWhere(userId), or(isNull(issues.id), failedJobIssueWhere())) as SQL;
}

export function selectFailedJobs(
  userId: string,
  scope: AttentionScope = {},
  limit: BucketLimit = BUCKET_CAPS.failedJobs,
): Promise<AttentionFailedJobRow[]> {
  return capped(
    db
      .select({
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

export function pendingSkillUpdateWhere(userId: string, scope: AttentionScope): SQL {
  return and(
    adminsProject(userId),
    inScope(scope),
    or(
      and(eq(reconcileRuns.status, 'decided'), eq(reconcileRuns.gate, 'human')),
      and(
        eq(reconcileRuns.status, 'escalated'),
        eq(reconcileRuns.verdict, 'escalate'),
        isNull(reconcileRuns.acknowledgedAt),
      ),
    ),
  ) as SQL;
}

export function selectPendingSkillUpdates(
  userId: string,
  scope: AttentionScope = {},
  limit: BucketLimit = BUCKET_CAPS.pendingSkillUpdates,
): Promise<AttentionReconcileRow[]> {
  return capped(
    db
      .select({
        status: reconcileRuns.status,
        createdAt: reconcileRuns.createdAt,
        decidedAt: reconcileRuns.decidedAt,
        projectSlug: projects.slug,
        projectName: projects.name,
      })
      .from(reconcileRuns)
      .innerJoin(projects, eq(projects.id, reconcileRuns.projectId))
      .where(pendingSkillUpdateWhere(userId, scope))
      .orderBy(desc(sql`coalesce(${reconcileRuns.decidedAt}, ${reconcileRuns.createdAt})`))
      .$dynamic(),
    limit,
  ) as unknown as Promise<AttentionReconcileRow[]>;
}
