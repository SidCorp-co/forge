import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueAttachments, issues, jobs, projectMembers, usageRecords } from '../db/schema.js';
import { emptyUsageTotals, usageSessionMatch, usageTotalsSelection } from './ports.js';
import { type WorkStateView, workStateViewSql } from './work-state.js';

/**
 * An issue as every reader is handed it: the row, `sessionContext` composed with the work state's
 * lease, and the work state — one statement,
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

/** Whether `userId` is a member of the project. */
export async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row !== undefined;
}
type IssueScope = Pick<IssueRow, 'id' | 'projectId' | 'status' | 'mergedAt'>;

/** The few columns a route needs to gate on an issue before acting on it. */
export async function issueScopeOf(issueId: string): Promise<IssueScope | null> {
  const [row] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ?? null;
}

/** An issue's attachments, oldest first, without their storage paths. */
export async function listIssueAttachments(issueId: string) {
  return db
    .select({
      id: issueAttachments.id,
      issueId: issueAttachments.issueId,
      uploaderId: issueAttachments.uploaderId,
      name: issueAttachments.name,
      mime: issueAttachments.mime,
      size: issueAttachments.size,
      createdAt: issueAttachments.createdAt,
    })
    .from(issueAttachments)
    .where(eq(issueAttachments.issueId, issueId))
    .orderBy(asc(issueAttachments.createdAt));
}

/** One attachment with its storage path and the project of the issue it hangs on. */
export async function attachmentWithProject(attachmentId: string) {
  const [row] = await db
    .select({
      id: issueAttachments.id,
      issueId: issueAttachments.issueId,
      uploaderId: issueAttachments.uploaderId,
      name: issueAttachments.name,
      mime: issueAttachments.mime,
      path: issueAttachments.path,
      projectId: issues.projectId,
    })
    .from(issueAttachments)
    .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
    .where(eq(issueAttachments.id, attachmentId))
    .limit(1);
  return row ?? null;
}

/** The usage totals of every session an issue's jobs ran in. */
export async function issueUsageTotals(issueId: string) {
  const sessionIdSubquery = sql`(
      SELECT DISTINCT ${jobs.agentSessionId}::text
      FROM ${jobs}
      WHERE ${jobs.issueId} = ${issueId}
        AND ${jobs.agentSessionId} IS NOT NULL
    )`;
  const [totals] = await db
    .select(usageTotalsSelection())
    .from(usageRecords)
    .where(usageSessionMatch(sql`IN ${sessionIdSubquery}`));
  return totals ?? emptyUsageTotals();
}

/** What a status move reads of the issue before it gates and applies. */
export async function transitionIssueRow(issueId: string) {
  const [row] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      issSeq: issues.issSeq,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ?? null;
}
