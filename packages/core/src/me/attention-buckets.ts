import { ISSUE_RESOLVED_STATUSES } from '@forge/contracts/issue-machine';
import { and, desc, eq, isNull, notExists, notInArray, or, sql } from 'drizzle-orm';
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
  projects,
} from '../db/schema.js';
import { issueArchiveSide } from '../issues/index.js';

const PER_BUCKET = 5;

const retryJobs = alias(jobs, 'retry_jobs');

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
        or(
          isNull(issues.id),
          and(notInArray(issues.status, [...ISSUE_RESOLVED_STATUSES]), ...issueArchiveSide(false)),
        ),
      ),
    )
    .orderBy(desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`))
    .limit(PER_BUCKET) as Promise<AttentionFailedJobRow[]>;
}
