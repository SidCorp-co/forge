import type { FeedbackSourceView } from '@forge/contracts/feedback';
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentReports, issues } from '../db/schema.js';
import { feedbackRouteIssues } from '../db/schema-feedback.js';
import { feedbackLinksOf, rowIn as requirementIn } from '../requirements/index.js';
import type { Row } from './read.js';

export const NO_FEEDBACK = '00000000-0000-0000-0000-000000000000';

export async function feedbackIdsOfRequirement(projectId: string, ref: string): Promise<string[]> {
  const req = await requirementIn(db, projectId, ref);
  return (await feedbackLinksOf(projectId, [req.id])).map((l) => l.feedbackId);
}

// ISS-93: the reference is stored once, on the report (`agent_reports.feedback_id`), and read
// back here for the item; it carries the report's metadata only, never its text, so it reads the
// same at every data policy
export async function sourceOf(feedbackId: string): Promise<FeedbackSourceView | null> {
  const [r] = await db
    .select({
      id: agentReports.id,
      kind: agentReports.kind,
      severity: agentReports.severity,
      target: agentReports.target,
      targetRef: agentReports.targetRef,
      createdAt: agentReports.createdAt,
    })
    .from(agentReports)
    .where(eq(agentReports.feedbackId, feedbackId))
    .limit(1);
  return r ? { agentReport: { ...r, createdAt: r.createdAt.toISOString() } } : null;
}

/** Every issue an issue route names, per item, oldest issue first. */
export async function routeIssuesOf(rows: Row[]): Promise<Map<string, string[]>> {
  const routed = rows.filter((r) => r.route === 'issue').map((r) => r.id);
  const out = new Map<string, string[]>();
  if (routed.length === 0) return out;
  const links = await db
    .select({ feedbackId: feedbackRouteIssues.feedbackId, issueId: feedbackRouteIssues.issueId })
    .from(feedbackRouteIssues)
    .innerJoin(issues, eq(issues.id, feedbackRouteIssues.issueId))
    .where(inArray(feedbackRouteIssues.feedbackId, routed))
    .orderBy(asc(issues.issSeq));
  for (const l of links) out.set(l.feedbackId, [...(out.get(l.feedbackId) ?? []), l.issueId]);
  return out;
}
