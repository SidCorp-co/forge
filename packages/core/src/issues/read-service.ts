import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { type WorkStateView, workStateViewSql } from './work-state.js';

/**
 * An issue as every reader is handed it: the row, `sessionContext` composed with the work state's
 * lease (cm:hack, `work-state.ts:composedSessionContextSql`), and the work state — one statement,
 * so a reply cannot pair a status with another moment's step.
 */
export type IssueRow = typeof issues.$inferSelect & { workState: WorkStateView | null };

export const ISSUE_READ_COLUMNS = {
  ...getTableColumns(issues),
  sessionContext: sql<
    IssueRow['sessionContext']
  >`issue_session_context("issues"."id", "issues"."session_context")`
    .mapWith(issues.sessionContext)
    .as('session_context'),
  workState: workStateViewSql.as('work_state'),
};

/**
 * Returns null rather than throwing: the error vocabulary belongs to the
 * transport. REST answers 404 `issue not found`, MCP answers
 * `NOT_FOUND: issue not found`, and both are asserted by their own tests.
 */
export async function findIssueById(issueId: string): Promise<IssueRow | null> {
  const [row] = await db
    .select(ISSUE_READ_COLUMNS)
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
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
    .select(ISSUE_READ_COLUMNS)
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, issSeq)))
    .limit(1);
  return row ?? null;
}
