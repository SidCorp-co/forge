/**
 * Comment reads and writes both transports share.
 *
 * The queries live here rather than beside a route or a tool because each
 * side had grown its own: the step-start tool primes an agent with a comment
 * thread, the comments tool lists the same thread, and REST serves the UI.
 * The projections are one now; the authorisation stays with each caller,
 * which is where the credential is known.
 */

import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';

export type CommentThreadRow = {
  id: string;
  issueId: string;
  authorId: string;
  isAi: boolean;
  body: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const threadColumns = {
  id: comments.id,
  issueId: comments.issueId,
  authorId: comments.authorId,
  isAi: comments.isAi,
  body: comments.body,
  parentId: comments.parentId,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
} as const;

/** One issue's comments, oldest first. `limit` may overfetch by one to test for more. */
export async function listIssueComments(issueId: string, limit?: number) {
  const q = db
    .select(threadColumns)
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .orderBy(asc(comments.createdAt));
  return limit === undefined ? q : q.limit(limit);
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
  isAi: boolean;
  body: string;
  parentId: string | null;
};

/** Insert one comment and hand back the thread projection of it. */
export async function insertComment(input: NewComment): Promise<CommentThreadRow> {
  const [row] = await db.insert(comments).values(input).returning(threadColumns);
  if (!row) throw new Error('comment insert returned no row');
  return row;
}

/** Remove one comment. Emitting `commentDeleted` belongs to the caller. */
export async function deleteComment(commentId: string): Promise<void> {
  await db.delete(comments).where(eq(comments.id, commentId));
}
