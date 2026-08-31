/**
 * The friction-report store, for whichever surface asks.
 *
 * `reportColumns` is the shape every read answers with — it joins the project
 * slug in, so a caller reading the feed never has to resolve one itself.
 */

import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
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

// cm:guard ISS-557 — a steward run is a schedule session with NO job row, so the job-join the caller tries first resolves null and its pipeline context comes back empty. This session-level lookup is what covers both pipeline and schedule sessions; removing it silently drops every steward report's attribution.
export async function resolveActiveSessionId(deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.deviceId, deviceId), eq(agentSessions.status, 'running')))
    .orderBy(desc(agentSessions.updatedAt))
    .limit(1);
  return row?.id ?? null;
}

export async function countReportsForJob(jobId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(feedbackReports)
    .where(eq(feedbackReports.jobId, jobId))
    .limit(1);
  return Number(row?.n ?? 0);
}

export async function listReports(conditions: Array<SQL | undefined>, limit: number) {
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

// cm:guard the scope predicate is the caller's and it is NOT optional: it is what stops a member of project A stamping a report in project B by guessing its id. `stampReviewed` applies it as a WHERE, never as a post-filter — an update that matched nothing must return zero rows, not throw after the write.
export async function stampReviewed(scope: Array<SQL | undefined>, patch: Record<string, unknown>) {
  return db
    .update(feedbackReports)
    .set(patch)
    .where(and(...scope))
    .returning({
      id: feedbackReports.id,
      reviewedAt: feedbackReports.reviewedAt,
      linkedIssueId: feedbackReports.linkedIssueId,
    });
}

export type { FeedbackKind, FeedbackSeverity, FeedbackTarget };
