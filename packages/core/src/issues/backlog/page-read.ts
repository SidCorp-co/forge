/**
 * The paged read of matching issues both backlog streams share (ISS-1173).
 *
 * The cursor carries `created_at` to the microsecond Postgres holds, era included, because the
 * `Date` drizzle returns holds milliseconds and a truncated cursor is strictly below the row it
 * came from, which re-reads that row at the head of the next page. `(created_at, id)` is a total
 * order, so two rows sharing one microsecond are separated by `id` and each is read once.
 */

import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { SelectedFields } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import { type IssueStatus, issues } from '../../db/schema.js';
import { issueArchiveSide } from '../archive.js';

export const CURSOR_AT = sql<
  string | null
>`to_char(${issues.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z" BC')`;

export interface PageCursor {
  cursorAt: string;
  id: string;
}

/** ISS-1237 — neither stream reads an archived issue: not as a row to rank, not as an alike seed. */
export function matchingIssues(projectId: string, statuses: IssueStatus[]) {
  return and(
    eq(issues.projectId, projectId),
    inArray(issues.status, statuses),
    ...issueArchiveSide(false),
  );
}

export async function countMatching(projectId: string, statuses: IssueStatus[]): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(matchingIssues(projectId, statuses));
  return row?.n ?? 0;
}

/** `to_char` answers NULL for `infinity`; paging from NULL reads nothing and calls that complete. */
export function cursorFrom(row: { id: string; cursorAt: string | null }): PageCursor {
  if (row.cursorAt === null) {
    throw Object.assign(
      new Error(
        `issue ${row.id} carries a created_at no page cursor can represent (an infinite ` +
          'timestamp); refusing rather than reporting this stream complete over the rest',
      ),
      { code: 'UNPAGEABLE_TIMESTAMP' },
    );
  }
  return { cursorAt: row.cursorAt, id: row.id };
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
