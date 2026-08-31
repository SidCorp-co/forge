import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';

/**
 * The issue row as the table defines it. Both transports previously kept their
 * own hand-written subset of these columns — `mcp/tools/forge-issues.ts` had
 * `source`/`externalId`/`mergedAt`/`reopenCount`/`sessionContext`, REST had
 * `createdVia`/`metadata`, and neither could see a column the other read.
 */
export type IssueRow = typeof issues.$inferSelect;

/**
 * Returns null rather than throwing: the error vocabulary belongs to the
 * transport. REST answers 404 `issue not found`, MCP answers
 * `NOT_FOUND: issue not found`, and both are asserted by their own tests.
 */
export async function findIssueById(issueId: string): Promise<IssueRow | null> {
  const [row] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
  return row ?? null;
}

export async function findIssueProjectId(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.projectId ?? null;
}

export async function findIssueByDisplaySeq(
  projectId: string,
  issSeq: number,
): Promise<IssueRow | null> {
  const [row] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, issSeq)))
    .limit(1);
  return row ?? null;
}
