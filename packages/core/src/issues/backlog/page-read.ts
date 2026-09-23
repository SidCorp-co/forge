/**
 * The paged read of matching issues both backlog streams share (ISS-1173).
 *
 * The cursor carries `created_at` to the microsecond Postgres holds, because the `Date` drizzle
 * returns holds milliseconds: a truncated cursor is strictly below the row it was taken from, so
 * that row satisfies `>` and is re-read as the first row of the next page. `(created_at, id)` is a
 * total order, so two rows sharing one microsecond are separated by `id` and each is read once.
 */

import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { SelectedFields } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import { type IssueStatus, issues } from '../../db/schema.js';

export const CURSOR_AT = sql<string>`to_char(${issues.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface PageCursor {
  cursorAt: string;
  id: string;
}

export function matchingIssues(projectId: string, statuses: IssueStatus[]) {
  return and(eq(issues.projectId, projectId), inArray(issues.status, statuses));
}

export async function countMatching(projectId: string, statuses: IssueStatus[]): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(matchingIssues(projectId, statuses));
  return row?.n ?? 0;
}

function afterCursor(cursor: PageCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${issues.createdAt}, ${issues.id}) > (${cursor.cursorAt}::timestamptz, ${cursor.id}::uuid)`;
}

export function issuePage<T extends SelectedFields>(args: {
  columns: T;
  projectId: string;
  statuses: IssueStatus[];
  after: PageCursor | null;
  limit: number;
}) {
  return db
    .select({ ...args.columns, cursorAt: CURSOR_AT })
    .from(issues)
    .where(and(matchingIssues(args.projectId, args.statuses), afterCursor(args.after)))
    .orderBy(asc(issues.createdAt), asc(issues.id))
    .limit(args.limit);
}
