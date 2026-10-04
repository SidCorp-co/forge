import type { FeedbackSourceView } from '@forge/contracts/feedback';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentReports } from '../db/schema.js';
import { feedbackLinksOf, rowIn as requirementIn } from '../requirements/index.js';

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
