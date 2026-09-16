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
import { db, type Tx } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { type CommentCursor, encodeCommentCursor } from './cursor.js';
import { screenAgentComment } from './screen.js';

export type CommentThreadRow = {
  id: string;
  issueId: string;
  authorId: string;
  authorDeviceId: string | null;
  body: string;
  format: BodyFormat;
  stage: string | null;
  authorAgency: ActorAgency | null;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The columns every comment surface projects — REST tree, MCP list and both writes. */
export const commentThreadColumns = {
  id: comments.id,
  issueId: comments.issueId,
  authorId: comments.authorId,
  authorDeviceId: comments.authorDeviceId,
  body: comments.body,
  format: comments.format,
  stage: comments.stage,
  authorAgency: comments.authorAgency,
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
  /**
   * Who was at the keyboard, from the principal the door authenticated.
   *
   * REQUIRED, and never defaulted — the same reasoning `actorAgency`'s own
   * guard states: a door that forgets it would silently write every agent's
   * comment as a person's, which both exempts it from the mandate and drops it
   * out of the number that decides the mandate.
   */
  authorAgency: ActorAgency | null;
  body: string;
  format?: BodyFormat | null | undefined;
  parentId: string | null;
};

/** A written comment plus whatever the sanitizer removed on the way in. */
export type WrittenComment = { row: CommentThreadRow; warnings: string[] };

/**
 * The stage a body write happens at: `issues.status` IS the stage name
 * (`STAGE_NAMES` in `pipeline-config-schema.ts` — "a key here must be a status
 * this lane actually reaches").
 */
async function loadStageContext(
  issueId: string,
  tx: Tx = db,
): Promise<{ stage: string; projectId: string } | null> {
  const [row] = await tx
    .select({ stage: issues.status, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ? { stage: row.stage, projectId: row.projectId } : null;
}

export async function insertComment(input: NewComment, tx: Tx = db): Promise<WrittenComment> {
  const prepared = prepareBody({ raw: input.body, format: input.format });
  const context = await loadStageContext(input.issueId, tx);
  if (input.authorAgency === 'agent' && context) {
    await screenAgentComment(context.projectId, input.body, tx);
  }

  const { format: _ignored, ...rest } = input;
  const [row] = await tx
    .insert(comments)
    .values({
      ...rest,
      body: prepared.body,
      format: prepared.format,
      stage: context?.stage ?? null,
    })
    .returning(commentThreadColumns);
  if (!row) throw new Error('comment insert returned no row');
  return { row, warnings: prepared.warnings };
}

/**
 * Replace one comment's body, re-validating it. Returns null when it is gone.
 *
 * `stage` is NOT rewritten. It records when the comment was WRITTEN, and an
 * edit does not move that; rewriting it would make a comment written at `open`
 * and corrected an hour later count towards whatever stage the issue reached
 * meanwhile, which is the exact misattribution the column exists to prevent.
 */
export async function updateCommentBody(
  commentId: string,
  input: { body: string; format?: BodyFormat | null | undefined },
): Promise<WrittenComment | null> {
  const prepared = prepareBody({ raw: input.body, format: input.format });
  const [existing] = await db
    .select({ issueId: comments.issueId, authorAgency: comments.authorAgency })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);
  if (!existing) return null;
  if (existing.authorAgency === 'agent') {
    const context = await loadStageContext(existing.issueId);
    if (context) await screenAgentComment(context.projectId, input.body, db);
  }

  const [row] = await db
    .update(comments)
    .set({
      body: prepared.body,
      format: prepared.format,
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
