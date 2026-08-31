/**
 * Where an attachment lives, and which project may see it.
 *
 * Every one of these is a scoping read the authorisation gate runs BEFORE the
 * bytes are touched, so the answer must come from the row, never from what the
 * caller said the target was.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
  commentAttachments,
  comments,
  issueAttachments,
  issues,
  sessionAttachments,
} from '../db/schema.js';

export async function loadIssueProjectId(issueId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row.projectId;
}

export async function loadCommentProjectId(commentId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(eq(comments.id, commentId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: comment not found');
  return row.projectId;
}

export async function loadSessionProjectId(sessionId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: agentSessions.projectId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: session not found');
  return row.projectId;
}

interface AttachmentForFetch {
  name: string;
  mime: string;
  size: number;
  path: string;
  projectId: string;
  url: string;
}

export async function loadAttachmentForFetch(
  target: 'issue' | 'comment' | 'session',
  attachmentId: string,
): Promise<AttachmentForFetch> {
  if (target === 'session') {
    const [row] = await db
      .select({
        name: sessionAttachments.name,
        mime: sessionAttachments.mime,
        size: sessionAttachments.size,
        path: sessionAttachments.path,
        sessionId: sessionAttachments.sessionId,
        projectId: agentSessions.projectId,
      })
      .from(sessionAttachments)
      .innerJoin(agentSessions, eq(agentSessions.id, sessionAttachments.sessionId))
      .where(eq(sessionAttachments.id, attachmentId))
      .limit(1);
    if (!row) throw new Error('NOT_FOUND: attachment not found');
    const { sessionId, ...rest } = row;
    return {
      ...rest,
      url: `/api/agent-sessions/${sessionId}/attachments/${attachmentId}/download`,
    };
  }
  if (target === 'issue') {
    const [row] = await db
      .select({
        name: issueAttachments.name,
        mime: issueAttachments.mime,
        size: issueAttachments.size,
        path: issueAttachments.path,
        projectId: issues.projectId,
      })
      .from(issueAttachments)
      .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
      .where(eq(issueAttachments.id, attachmentId))
      .limit(1);
    if (!row) throw new Error('NOT_FOUND: attachment not found');
    return { ...row, url: `/api/attachments/${attachmentId}/download` };
  }
  const [row] = await db
    .select({
      name: commentAttachments.name,
      mime: commentAttachments.mime,
      size: commentAttachments.size,
      path: commentAttachments.path,
      projectId: issues.projectId,
    })
    .from(commentAttachments)
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(eq(commentAttachments.id, attachmentId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: attachment not found');
  return { ...row, url: `/api/comments/attachments/${attachmentId}` };
}
