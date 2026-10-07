import type { CommentIntent } from '@forge/contracts/record-events';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { commentAttachments, comments, issues } from '../db/schema.js';
import { commentRowIn, placeOfComment } from './entity-read.js';
import { commentThreadColumns } from './service.js';
import type { CommentAttachmentLite } from './tree.js';

/** The issue's id and project; null when absent. */
export async function issueProjectOf(
  issueId: string,
): Promise<{ id: string; projectId: string } | null> {
  const [row] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ?? null;
}

/** Where a comment sits: on an issue (with what its edit routes need), or on another entity; null when absent. */
export async function locateComment(commentId: string) {
  const [row] = await db
    .select({
      id: comments.id,
      issueId: issues.id,
      authorId: comments.authorId,
      body: comments.body,
      projectId: issues.projectId,
    })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(eq(comments.id, commentId))
    .limit(1);
  if (row) return { onIssue: row, elsewhere: null };
  const elsewhere = await commentRowIn(db, commentId);
  if (!elsewhere) return null;
  return { onIssue: null, elsewhere: await placeOfComment(db, elsewhere) };
}

/** A comment's id and issue, as a reply's parent; null when absent. */
export async function parentCommentOf(
  parentId: string,
): Promise<{ id: string; issueId: (typeof comments.$inferSelect)['issueId'] } | null> {
  const [parent] = await db
    .select({ id: comments.id, issueId: comments.issueId })
    .from(comments)
    .where(eq(comments.id, parentId))
    .limit(1);
  return parent ?? null;
}

/** How many comments the issue carries, of one intent when given. */
export async function countIssueComments(
  issueId: string,
  intent: CommentIntent | undefined,
): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(comments)
    .where(
      intent
        ? and(eq(comments.issueId, issueId), eq(comments.intent, intent))
        : eq(comments.issueId, issueId),
    );
  return Number(n);
}

/** Each comment's attachments, oldest first, keyed by comment id, in one grouped query. */
export async function attachmentsByComment(
  commentIds: string[],
): Promise<Map<string, CommentAttachmentLite[]>> {
  const out = new Map<string, CommentAttachmentLite[]>();
  if (commentIds.length === 0) return out;
  const rows = await db
    .select({
      id: commentAttachments.id,
      commentId: commentAttachments.commentId,
      name: commentAttachments.name,
      mime: commentAttachments.mime,
      size: commentAttachments.size,
      createdAt: commentAttachments.createdAt,
    })
    .from(commentAttachments)
    .where(inArray(commentAttachments.commentId, commentIds))
    .orderBy(asc(commentAttachments.createdAt));
  for (const a of rows) {
    const list = out.get(a.commentId) ?? [];
    list.push({
      id: a.id,
      name: a.name,
      mime: a.mime,
      size: a.size,
      createdAt: a.createdAt,
      url: `/api/comments/attachments/${a.id}`,
    });
    out.set(a.commentId, list);
  }
  return out;
}

/** One page of a comment's replies, oldest first, with their total. */
export async function listReplies(parentId: string, limit: number, offset: number) {
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(comments)
    .where(eq(comments.parentId, parentId));
  const rows = await db
    .select(commentThreadColumns)
    .from(comments)
    .where(eq(comments.parentId, parentId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(limit)
    .offset(offset);
  return { rows, total: Number(n) };
}

/** An issue comment with its project, as an attachment target; null when absent. */
export async function issueCommentForAttachment(commentId: string): Promise<{
  id: string;
  issueId: (typeof comments.$inferSelect)['issueId'];
  projectId: string;
} | null> {
  const [comment] = await db
    .select({ id: comments.id, issueId: comments.issueId, projectId: issues.projectId })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(eq(comments.id, commentId))
    .limit(1);
  return comment ?? null;
}

/** A comment attachment's stored file and the project it is read under; null when absent. */
export async function commentAttachmentFile(id: string) {
  const [row] = await db
    .select({
      id: commentAttachments.id,
      path: commentAttachments.path,
      mime: commentAttachments.mime,
      name: commentAttachments.name,
      projectId: issues.projectId,
    })
    .from(commentAttachments)
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(eq(commentAttachments.id, id))
    .limit(1);
  return row ?? null;
}
