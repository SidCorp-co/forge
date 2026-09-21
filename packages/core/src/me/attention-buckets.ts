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
import { creatorIsAgentCondition } from '../issues/creator.js';
import { ISSUE_RESOLVED_STATUSES } from '../issues/status-sets.js';
import { visibleProjectsWhere } from '../lib/authz.js';

export const NEEDS_REVIEW_STATUSES = ['developed', 'reopen'] as const;
export const AWAITING_INPUT_STATUSES = ['waiting', 'needs_info'] as const;
const PER_BUCKET = 5;
const PENDING_SKILL_UPDATES_CAP = 20;

export const UNSEEN_DRAFTS_CAP = 20;

export const AWAITING_INPUT_CAP = 20;

const retryJobs = alias(jobs, 'retry_jobs');

export interface AttentionIssueRow {
  id: string;
  issSeq: number;
  issuePrefix: string | null;
  title: string;
  status: string;
  updatedAt: Date;
  projectSlug: string;
  projectName: string;
}

/** The awaiting-input row, which carries WHY it is ranked where it is. */
export interface AttentionAwaitingRow extends AttentionIssueRow {
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
  issueDocId: string | null;
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

const issueFields = {
  id: issues.id,
  issSeq: issues.issSeq,
  issuePrefix: projects.issuePrefix,
  title: issues.title,
  status: issues.status,
  updatedAt: issues.updatedAt,
  projectSlug: projects.slug,
  projectName: projects.name,
} as const;

export function selectNeedsReview(userId: string): Promise<AttentionIssueRow[]> {
  return db
    .select(issueFields)
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(eq(issues.assigneeId, userId), inArray(issues.status, [...NEEDS_REVIEW_STATUSES])))
    .orderBy(desc(issues.updatedAt))
    .limit(PER_BUCKET) as Promise<AttentionIssueRow[]>;
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

export function selectAwaitingInput(userId: string): Promise<AttentionAwaitingRow[]> {
  return db
    .select({
      ...issueFields,
      claimsHeld: openQuestionCost('claims_held'),
      workspacesPinned: openQuestionCost('workspaces_pinned'),
      dependents: openQuestionCost('dependents'),
      blockerKind: openQuestionColumn('blocker_kind'),
      questionId: openQuestionColumn('id'),
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId)),
    )
    .where(
      and(
        ownedForAnswer(userId),
        inArray(issues.status, [...AWAITING_INPUT_STATUSES]),
        ...visibleProjectsWhere(),
      ),
    )
    .orderBy(...AWAITING_COST_ORDER)
    .limit(AWAITING_INPUT_CAP) as Promise<AttentionAwaitingRow[]>;
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

function unseenDraftCondition(userId: string): SQL {
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

export function selectUnseenDrafts(userId: string): Promise<AttentionIssueRow[]> {
  return db
    .select(issueFields)
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(unseenDraftCondition(userId))
    .orderBy(PRIORITY_RANK, desc(issues.updatedAt))
    .limit(UNSEEN_DRAFTS_CAP) as Promise<AttentionIssueRow[]>;
}

export function selectUnseenDraftCount(userId: string): Promise<{ total: number | null }[]> {
  return db
    .select({ total: sql<number>`count(*)::int` })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(unseenDraftCondition(userId)) as Promise<{ total: number | null }[]>;
}

export function selectMentions(userId: string): Promise<AttentionMentionRow[]> {
  return db
    .select({
      notificationTitle: notifications.title,
      mentionedAt: commentMentions.createdAt,
      issueDocId: issues.id,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
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
    .where(and(eq(commentMentions.userId, userId), sql`${notificationDeliveries.readAt} IS NULL`))
    .orderBy(desc(commentMentions.createdAt))
    .limit(PER_BUCKET) as Promise<AttentionMentionRow[]>;
}

export function selectFailedJobs(userId: string): Promise<AttentionFailedJobRow[]> {
  return db
    .select({
      type: jobs.type,
      finishedAt: jobs.finishedAt,
      createdAt: jobs.createdAt,
      error: jobs.error,
      issueDocId: issues.id,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
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
        notExists(db.select({ one: sql`1` }).from(retryJobs).where(eq(retryJobs.retryOf, jobs.id))),
        or(isNull(issues.id), notInArray(issues.status, [...ISSUE_RESOLVED_STATUSES])),
      ),
    )
    .orderBy(desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`))
    .limit(PER_BUCKET) as Promise<AttentionFailedJobRow[]>;
}

export function selectPendingSkillUpdates(userId: string): Promise<AttentionReconcileRow[]> {
  return db
    .select({
      status: reconcileRuns.status,
      createdAt: reconcileRuns.createdAt,
      decidedAt: reconcileRuns.decidedAt,
      projectSlug: projects.slug,
      projectName: projects.name,
    })
    .from(reconcileRuns)
    .innerJoin(projects, eq(projects.id, reconcileRuns.projectId))
    .where(
      and(
        adminsProject(userId),
        or(
          and(eq(reconcileRuns.status, 'decided'), eq(reconcileRuns.gate, 'human')),
          and(
            eq(reconcileRuns.status, 'escalated'),
            eq(reconcileRuns.verdict, 'escalate'),
            isNull(reconcileRuns.acknowledgedAt),
          ),
        ),
      ),
    )
    .orderBy(desc(sql`coalesce(${reconcileRuns.decidedAt}, ${reconcileRuns.createdAt})`))
    .limit(PENDING_SKILL_UPDATES_CAP) as Promise<AttentionReconcileRow[]>;
}
