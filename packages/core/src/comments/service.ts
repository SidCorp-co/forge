/**
 * Comment reads and writes both transports share.
 *
 * The queries live here rather than beside a route or a tool because each
 * side had grown its own: the step-start tool primes an agent with a comment
 * thread, the comments tool lists the same thread, and REST serves the UI.
 * The projections are one now; the authorisation stays with each caller,
 * which is where the credential is known.
 */

import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { BodyFormat } from '../body/formats.js';
import { prepareBody } from '../body/prepare.js';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import { type CommentCursor, encodeCommentCursor } from './cursor.js';

export type CommentThreadRow = {
  id: string;
  issueId: string;
  authorId: string;
  authorDeviceId: string | null;
  body: string;
  format: BodyFormat;
  template: string | null;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The columns every comment surface projects — REST tree, MCP list and both writes. */
// cm:guard REST and MCP answer comments off THIS ONE object. `comments/routes.ts` kept a byte-identical private copy until ISS-956; two projections that must agree and nothing making them is how one surface silently gains or loses a field.
export const commentThreadColumns = {
  id: comments.id,
  issueId: comments.issueId,
  authorId: comments.authorId,
  authorDeviceId: comments.authorDeviceId,
  body: comments.body,
  format: comments.format,
  template: comments.template,
  parentId: comments.parentId,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
} as const;

/** One issue's comments, oldest first, all of them. */
export async function listIssueComments(issueId: string) {
  return db
    .select(commentThreadColumns)
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

/**
 * Comment depth the DB trigger allows. A root plus this many rounds of
 * `parent_id IN (…)` reaches every descendant of the roots on a page.
 */
// cm:edge lockstep -> packages/core/drizzle/migrations — the depth-3 check trigger is what makes a fixed number of rounds complete rather than a guess. Raising the trigger's depth without raising this leaves the deepest replies off every page, silently, because `buildCommentTree` drops a reply whose parent it was not given.
const COMMENT_MAX_DEPTH = 3;

export type CommentPage = {
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
// cm:edge contract -> packages/core/src/comments/cursor.ts — this rendering IS the token's timestamp half, so the format here and `decodeCommentCursor`'s acceptance must agree; `to_char` with `US` is exact for a timestamptz, and the token is compared back as `::timestamptz` rather than parsed in JS so no precision is lost on the way in either.
const cursorKeyExpr = sql<string>`to_char(${comments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One page of an issue's thread: the next `limit` ROOT comments after
 * `after`, each with its whole subtree.
 *
 * ISS-956. The cursor walks roots rather than comments because
 * `buildCommentTree` drops a reply whose parent is absent from the row set it
 * is given — a deliberate guard, so that a partial fetch cannot promote a
 * reply to a top-level comment. Paging over roots is the one row set for
 * which that builder is correct on a partial fetch, and it is also what makes
 * a page self-contained for a flat reader: every `parentId` on the page names
 * a row that is on it.
 */
// cm:guard the keyset is `(createdAt, id)` and the tie-breaking `id` comparison is the whole of the second half — dropping to `createdAt > x` alone loses every root sharing a timestamp with the previous page's last. Agent-written threads produce those ties routinely (ISS-956 measured two at 2026-09-06T18:58).
export async function listIssueCommentPage(
  issueId: string,
  opts: { after?: CommentCursor | undefined; limit: number },
): Promise<CommentPage> {
  const { after, limit } = opts;
  const rootFilters = [eq(comments.issueId, issueId), isNull(comments.parentId)];
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

  // cm:guard `cursorKey` is stripped HERE and reaches no caller. `buildCommentTree` spreads each row into its node, so a key left on a root is an undeclared field on every REST comment; the MCP tool reads the keys it needs out of `cursorKeyById` instead.
  const cursorKeyById = new Map(keyed.map((r) => [r.id, r.cursorKey]));
  const roots = keyed.map(({ cursorKey: _key, ...row }) => row);

  const rows = [...roots];
  let frontier = roots.map((r) => r.id);
  for (let depth = 1; depth < COMMENT_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const replies = await db
      .select(commentThreadColumns)
      .from(comments)
      .where(inArray(comments.parentId, frontier))
      .orderBy(asc(comments.createdAt), asc(comments.id));
    rows.push(...replies);
    frontier = replies.map((r) => r.id);
  }

  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return { rows, roots, nextCursor, cursorKeyById };
}

/** The project an issue belongs to; throws when the issue is gone. */
export async function loadIssueProjectId(issueId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row.projectId;
}

export type CommentAccessRow = {
  id: string;
  issueId: string;
  authorId: string;
  projectId: string;
};

/** Who owns a comment and which project it sits under, for an access check. */
export async function loadCommentForAccess(commentId: string): Promise<CommentAccessRow> {
  const [row] = await db
    .select({
      id: comments.id,
      issueId: comments.issueId,
      authorId: comments.authorId,
      projectId: issues.projectId,
    })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(eq(comments.id, commentId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: comment not found');
  return row;
}

export type NewComment = {
  issueId: string;
  authorId: string;
  authorDeviceId: string | null;
  body: string;
  format?: BodyFormat | null | undefined;
  parentId: string | null;
};

/** A written comment plus whatever the sanitizer removed on the way in. */
export type WrittenComment = { row: CommentThreadRow; warnings: string[] };

// cm:guard ISS-898 — the caller-supplied body is validated HERE, not at each transport, because both REST and MCP create reach this one function and a gate on one of them is a gate on neither. The ~11 kernel-authored `db.insert(comments)` sites (apply-transition, budget-check, merge-marker, stage-stall-guard, pm/routes, release-batch) deliberately do NOT come through here: they take the `markdown` column default, which is right for text core formats itself.
export async function insertComment(input: NewComment): Promise<WrittenComment> {
  const prepared = prepareBody({ raw: input.body, format: input.format });
  const { format: _ignored, ...rest } = input;
  const [row] = await db
    .insert(comments)
    .values({
      ...rest,
      body: prepared.body,
      format: prepared.format,
      template: prepared.template,
    })
    .returning(commentThreadColumns);
  if (!row) throw new Error('comment insert returned no row');
  return { row, warnings: prepared.warnings };
}

/** Replace one comment's body, re-validating it. Returns null when it is gone. */
export async function updateCommentBody(
  commentId: string,
  input: { body: string; format?: BodyFormat | null | undefined },
): Promise<WrittenComment | null> {
  const prepared = prepareBody({ raw: input.body, format: input.format });
  const [row] = await db
    .update(comments)
    .set({
      body: prepared.body,
      format: prepared.format,
      template: prepared.template,
      updatedAt: new Date(),
    })
    .where(eq(comments.id, commentId))
    .returning(commentThreadColumns);
  return row ? { row, warnings: prepared.warnings } : null;
}

/** Remove one comment. Emitting `commentDeleted` belongs to the caller. */
export async function deleteComment(commentId: string): Promise<void> {
  await db.delete(comments).where(eq(comments.id, commentId));
}
