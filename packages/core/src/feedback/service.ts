/**
 * The friction-report store, for whichever surface asks.
 *
 * `reportColumns` is the shape every read answers with — it joins the project
 * slug in, so a caller reading the feed never has to resolve one itself.
 */

import { and, count, desc, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type FeedbackKind,
  type FeedbackSeverity,
  type FeedbackTarget,
  feedbackReports,
  issues,
  projects,
} from '../db/schema.js';

export const reportColumns = {
  id: feedbackReports.id,
  projectId: feedbackReports.projectId,
  projectSlug: projects.slug,
  issueId: feedbackReports.issueId,
  runId: feedbackReports.runId,
  jobId: feedbackReports.jobId,
  stage: feedbackReports.stage,
  kind: feedbackReports.kind,
  severity: feedbackReports.severity,
  target: feedbackReports.target,
  targetRef: feedbackReports.targetRef,
  summary: feedbackReports.summary,
  detail: feedbackReports.detail,
  suggestion: feedbackReports.suggestion,
  signalKey: feedbackReports.signalKey,
  sessionId: feedbackReports.sessionId,
  reviewedAt: feedbackReports.reviewedAt,
  linkedIssueId: feedbackReports.linkedIssueId,
  createdAt: feedbackReports.createdAt,
} as const;

export async function countReportsForJob(jobId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(feedbackReports)
    .where(eq(feedbackReports.jobId, jobId))
    .limit(1);
  return Number(row?.n ?? 0);
}

export type ReportFilters = {
  kind?: FeedbackKind | undefined;
  target?: FeedbackTarget | undefined;
  severity?: FeedbackSeverity | undefined;
  reviewed?: boolean | undefined;
};

/** What a stamp matches: one report by id, or every report sharing a signal key, inside these projects. */
export type ReviewMatch =
  | { projectIds: string[]; reportId: string }
  | { projectIds: string[]; signalKey: string };

export async function listReports(projectIds: string[], filters: ReportFilters, limit: number) {
  const conditions: Array<SQL | undefined> = [
    inArray(feedbackReports.projectId, projectIds),
    filters.kind ? eq(feedbackReports.kind, filters.kind) : undefined,
    filters.target ? eq(feedbackReports.target, filters.target) : undefined,
    filters.severity ? eq(feedbackReports.severity, filters.severity) : undefined,
    filters.reviewed === true ? isNotNull(feedbackReports.reviewedAt) : undefined,
    filters.reviewed === false ? isNull(feedbackReports.reviewedAt) : undefined,
  ];
  return db
    .select(reportColumns)
    .from(feedbackReports)
    .leftJoin(projects, eq(projects.id, feedbackReports.projectId))
    .where(and(...conditions))
    .orderBy(desc(feedbackReports.createdAt))
    .limit(limit);
}

export async function readReport(reportId: string) {
  const [row] = await db
    .select(reportColumns)
    .from(feedbackReports)
    .leftJoin(projects, eq(projects.id, feedbackReports.projectId))
    .where(eq(feedbackReports.id, reportId))
    .limit(1);
  return row ?? null;
}

/** Does this issue exist inside any of `projectIds`? */
export async function issueVisibleIn(issueId: string, projectIds: string[]): Promise<boolean> {
  if (projectIds.length === 0) return false;
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), inArray(issues.projectId, projectIds)))
    .limit(1);
  return row !== undefined;
}

export type NewFeedbackReport = typeof feedbackReports.$inferInsert;

export async function insertReport(values: NewFeedbackReport): Promise<string | null> {
  const [row] = await db.insert(feedbackReports).values(values).returning({
    id: feedbackReports.id,
  });
  return row?.id ?? null;
}

/**
 * Stamps `reviewedAt` on every report `match` names. `reviewed: false` clears the stamp and the
 * link together; `reviewed: true` leaves an existing link untouched unless `linkedIssueId` names a
 * new one.
 */
export async function stampReviewed(
  match: ReviewMatch,
  patch: { reviewed: boolean; linkedIssueId?: string | undefined },
) {
  const set: { reviewedAt: Date | null; linkedIssueId?: string | null } = {
    reviewedAt: patch.reviewed ? new Date() : null,
  };
  if (!patch.reviewed) set.linkedIssueId = null;
  else if (patch.linkedIssueId !== undefined) set.linkedIssueId = patch.linkedIssueId;

  const target =
    'reportId' in match
      ? eq(feedbackReports.id, match.reportId)
      : eq(feedbackReports.signalKey, match.signalKey);
  return db
    .update(feedbackReports)
    .set(set)
    .where(and(inArray(feedbackReports.projectId, match.projectIds), target))
    .returning({
      id: feedbackReports.id,
      reviewedAt: feedbackReports.reviewedAt,
      linkedIssueId: feedbackReports.linkedIssueId,
    });
}

export type { FeedbackKind, FeedbackSeverity, FeedbackTarget };
