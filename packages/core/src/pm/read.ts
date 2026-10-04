import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pmDecisions, pmPolicies } from '../db/schema.js';

export const policyColumns = {
  id: pmPolicies.id,
  projectId: pmPolicies.projectId,
  name: pmPolicies.name,
  body: pmPolicies.body,
  enabled: pmPolicies.enabled,
  priority: pmPolicies.priority,
  createdAt: pmPolicies.createdAt,
  updatedAt: pmPolicies.updatedAt,
};

/** One of the project's PM decisions, with the event it answered; null when absent. */
export async function decisionInProject(
  projectId: string,
  decisionId: string,
): Promise<{ id: string; eventRef: unknown } | null> {
  const [decision] = await db
    .select({ id: pmDecisions.id, eventRef: pmDecisions.eventRef })
    .from(pmDecisions)
    .where(and(eq(pmDecisions.id, decisionId), eq(pmDecisions.projectId, projectId)))
    .limit(1);
  return decision ?? null;
}

/** Whether `issueId` exists and belongs to `projectId`. */
export async function issueIsInProject(issueId: string, projectId: string): Promise<boolean> {
  const [issue] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return issue?.projectId === projectId;
}

/** The project's PM policies, highest priority first. */
export async function listPmPolicies(projectId: string) {
  return db
    .select(policyColumns)
    .from(pmPolicies)
    .where(eq(pmPolicies.projectId, projectId))
    .orderBy(desc(pmPolicies.priority), desc(pmPolicies.createdAt));
}

/** One page of the project's PM decisions, newest first, optionally of one cause. */
export async function listPmDecisions(
  projectId: string,
  q: { cause?: string | undefined; page: number; pageSize: number },
) {
  const conditions = [eq(pmDecisions.projectId, projectId)];
  if (q.cause) conditions.push(eq(pmDecisions.cause, q.cause));
  const where = and(...conditions);

  const [totalRow] = await db.select({ n: count() }).from(pmDecisions).where(where);
  const rows = await db
    .select({
      id: pmDecisions.id,
      projectId: pmDecisions.projectId,
      cause: pmDecisions.cause,
      summary: pmDecisions.summary,
      actions: pmDecisions.actions,
      confidence: pmDecisions.confidence,
      modelTier: pmDecisions.modelTier,
      tookMs: pmDecisions.tookMs,
      createdAt: pmDecisions.createdAt,
    })
    .from(pmDecisions)
    .where(where)
    .orderBy(desc(pmDecisions.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { rows, total: totalRow?.n ?? 0 };
}
