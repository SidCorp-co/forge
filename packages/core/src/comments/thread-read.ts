// Reading an issue's comment thread a page at a time.

import type { CommentIntent } from '@forge/contracts/record-events';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import { type CommentCursor, encodeCommentCursor } from './cursor.js';
import { type CommentThreadRow, commentThreadColumns } from './service.js';

// the issue thread reads issue comments only: a row on another target reaching it is an
// invariant break named here, never a thread entry with no issue
export function onIssue<T extends { id: string; issueId: string | null }>(
  row: T,
): T & { issueId: string } {
  if (row.issueId === null) {
    throw new Error(`comment ${row.id} sits on no issue, so the issue thread cannot carry it`);
  }
  return row as T & { issueId: string };
}

/**
 * Comment depth the DB trigger allows. A root plus this many rounds of
 * `parent_id IN (…)` reaches every descendant of the roots on a page.
 */
const COMMENT_MAX_DEPTH = 3;

type CommentPage = {
  /** Roots and every descendant of them, ascending by `(createdAt, id)`. */
  rows: CommentThreadRow[];
  /** The roots this page carries, in the order the cursor walks them. */
  roots: CommentThreadRow[];
  /** Where the next page resumes, or null when this page ended the thread. */
  nextCursor: string | null;
  /** Each root's exact `created_at` key, for a caller that mints its own token. */
  cursorKeyById: Map<string, string>;
};

/**
 * `created_at` as the DB's own microsecond text, which is what a cursor
 * carries. Selected only on the root query, never projected to a caller.
 */
const cursorKeyExpr = sql<string>`to_char(${comments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function listIssueCommentPage(
  issueId: string,
  opts: { after?: CommentCursor | undefined; limit: number; intent?: CommentIntent | undefined },
): Promise<CommentPage> {
  const { after, limit } = opts;
  const rootFilters = [eq(comments.issueId, issueId), isNull(comments.parentId)];
  if (opts.intent) rootFilters.push(eq(comments.intent, opts.intent));
  if (after) {
    const at = sql`${after.createdAtKey}::timestamptz`;
    rootFilters.push(
      or(
        sql`${comments.createdAt} > ${at}`,
        and(sql`${comments.createdAt} = ${at}`, gt(comments.id, after.id)),
      ) as NonNullable<ReturnType<typeof gt>>,
    );
  }

  const probed = await db
    .select({ ...commentThreadColumns, cursorKey: cursorKeyExpr })
    .from(comments)
    .where(and(...rootFilters))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(limit + 1);

  const keyed = probed.slice(0, limit);
  const last = keyed.at(-1);
  const nextCursor =
    probed.length > limit && last
      ? encodeCommentCursor({ createdAtKey: last.cursorKey, id: last.id })
      : null;

  const cursorKeyById = new Map(keyed.map((r) => [r.id, r.cursorKey]));
  const roots = keyed.map(({ cursorKey: _key, ...row }) => onIssue(row));

  const rows = [...roots];
  let frontier = roots.map((r) => r.id);
  for (let depth = 1; depth < COMMENT_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const replies = await db
      .select(commentThreadColumns)
      .from(comments)
      .where(inArray(comments.parentId, frontier))
      .orderBy(asc(comments.createdAt), asc(comments.id));
    rows.push(...replies.map(onIssue));
    frontier = replies.map((r) => r.id);
  }

  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return { rows, roots, nextCursor, cursorKeyById };
}
