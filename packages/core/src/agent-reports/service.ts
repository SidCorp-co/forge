/**
 * The friction-report store, for whichever surface asks.
 *
 * `reportColumns` is the shape every read answers with — it joins the project
 * slug in, so a caller reading the feed never has to resolve one itself.
 */

import type { AgentReportView } from '@forge/contracts/agent-reports';
import { and, count, desc, eq, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type AgentReportKind,
  type AgentReportSeverity,
  type AgentReportTarget,
  agentReports,
  issues,
  projects,
} from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { reportLinksOf } from '../feedback/about.js';
import type { Refusal } from '../lib/refusal.js';
import { promotedRefusals } from './rules.js';

export const reportColumns = {
  id: agentReports.id,
  projectId: agentReports.projectId,
  projectSlug: projects.slug,
  issueId: agentReports.issueId,
  runId: agentReports.runId,
  jobId: agentReports.jobId,
  stage: agentReports.stage,
  kind: agentReports.kind,
  severity: agentReports.severity,
  target: agentReports.target,
  targetRef: agentReports.targetRef,
  summary: agentReports.summary,
  detail: agentReports.detail,
  suggestion: agentReports.suggestion,
  signalKey: agentReports.signalKey,
  sessionId: agentReports.sessionId,
  reviewedAt: agentReports.reviewedAt,
  linkedIssueId: agentReports.linkedIssueId,
  feedbackId: agentReports.feedbackId,
  createdAt: agentReports.createdAt,
} as const;

export async function countReportsForJob(jobId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(agentReports)
    .where(eq(agentReports.jobId, jobId))
    .limit(1);
  return Number(row?.n ?? 0);
}

export async function listReports(conditions: Array<SQL | undefined>, limit: number) {
  return db
    .select(reportColumns)
    .from(agentReports)
    .leftJoin(projects, eq(projects.id, agentReports.projectId))
    .where(and(...conditions))
    .orderBy(desc(agentReports.createdAt))
    .limit(limit);
}

export async function readReport(reportId: string) {
  const [row] = await db
    .select(reportColumns)
    .from(agentReports)
    .leftJoin(projects, eq(projects.id, agentReports.projectId))
    .where(eq(agentReports.id, reportId))
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

export type NewAgentReport = typeof agentReports.$inferInsert;

export async function insertReport(values: NewAgentReport): Promise<string | null> {
  const [row] = await db.insert(agentReports).values(values).returning({
    id: agentReports.id,
  });
  return row?.id ?? null;
}

type ReportRow = Awaited<ReturnType<typeof listReports>>[number];

export async function reportViews(rows: readonly ReportRow[]): Promise<AgentReportView[]> {
  const byProject = new Map<string, string[]>();
  for (const r of rows) {
    if (r.feedbackId)
      byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r.feedbackId]);
  }
  const links = new Map(
    (
      await Promise.all([...byProject].map(([projectId, ids]) => reportLinksOf(projectId, ids)))
    ).flatMap((m) => [...m]),
  );
  return rows.map(({ feedbackId, ...r }) => ({
    ...r,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    feedback: feedbackId ? (links.get(feedbackId) ?? null) : null,
  }));
}

export type ReviewOutcome =
  | { ok: true; rows: { id: string; reviewedAt: Date | null; linkedIssueId: string | null }[] }
  | { ok: false; refusals: Refusal[] };

export async function stampReviewed(
  scope: Array<SQL | undefined>,
  patch: { reviewed: boolean; linkedIssueId?: string | null },
): Promise<ReviewOutcome> {
  const touchesRoute = !patch.reviewed || typeof patch.linkedIssueId === 'string';
  const promoted = touchesRoute
    ? await db
        .select({ id: agentReports.id, seq: feedback.fbSeq })
        .from(agentReports)
        .innerJoin(feedback, eq(feedback.id, agentReports.feedbackId))
        .where(and(...scope, isNotNull(agentReports.feedbackId)))
    : [];
  const refusals = promotedRefusals(promoted, patch.reviewed);
  if (refusals.length > 0) return { ok: false, refusals };
  const rows = await db
    .update(agentReports)
    .set({
      reviewedAt: patch.reviewed ? new Date() : null,
      ...(patch.linkedIssueId !== undefined ? { linkedIssueId: patch.linkedIssueId } : {}),
    })
    .where(and(...scope))
    .returning({
      id: agentReports.id,
      reviewedAt: agentReports.reviewedAt,
      linkedIssueId: agentReports.linkedIssueId,
    });
  return { ok: true, rows };
}

export type { AgentReportKind, AgentReportSeverity, AgentReportTarget };
