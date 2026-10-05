import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';

type PlannedAgainst = {
  plannedRevision: number | null;
};

/** The issue delivers this requirement, planned against the revision named. */
export async function linkIssueToRequirement(
  tx: Tx,
  issueId: string,
  requirementId: string,
  planned: PlannedAgainst,
): Promise<void> {
  await tx
    .update(issues)
    .set({ requirementId, ...planned, updatedAt: new Date() })
    .where(eq(issues.id, issueId));
}

/** The issue's existing plan is recorded as read against the revision named. */
export async function adoptIssuePlan(
  tx: Tx,
  issueId: string,
  planned: PlannedAgainst,
): Promise<void> {
  await tx
    .update(issues)
    .set({ ...planned, updatedAt: new Date() })
    .where(eq(issues.id, issueId));
}

/** The issue no longer delivers this requirement; a link to another one is left alone. */
export async function unlinkIssueFromRequirement(
  issueId: string,
  requirementId: string,
): Promise<void> {
  await db
    .update(issues)
    .set({
      requirementId: null,
      plannedRevision: null,
      updatedAt: new Date(),
    })
    .where(and(eq(issues.id, issueId), eq(issues.requirementId, requirementId)));
}
