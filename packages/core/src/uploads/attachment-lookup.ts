/**
 * Where an attachment lives, and which project may see it.
 *
 * Every one of these is a scoping read the authorisation gate runs BEFORE the
 * bytes are touched, so the answer must come from the row, never from what the
 * caller said the target was.
 */

import type { AttachmentRefusalCode } from '@forge/contracts/attachments';
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
import { getStorage, isEnoent } from '../integrations/index.js';
import { refuser } from '../lib/refusal.js';
import type { DownloadTargetType } from './download-ticket-service.js';

const refuseAttachment = refuser<AttachmentRefusalCode>('ATTACHMENT_REFUSED');

interface AttachmentRow {
  name: string;
  mime: string;
  size: number;
  path: string;
  projectId: string;
  url: string;
}

/** The row behind a download ticket or an MCP fetch, or null when no row has that id. */
export async function loadAttachment(
  target: DownloadTargetType,
  attachmentId: string,
): Promise<AttachmentRow | null> {
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
    if (!row) return null;
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
    if (!row) return null;
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
  if (!row) return null;
  return { ...row, url: `/api/comments/attachments/${attachmentId}` };
}

/** The stored bytes of an attachment row; a file gone from storage answers 404 ATTACHMENT_FILE_MISSING, naming no path. */
export async function readAttachmentBytes(att: AttachmentRow): Promise<Buffer> {
  try {
    return await getStorage().get(att.path);
  } catch (err) {
    if (!isEnoent(err)) throw err;
    throw refuseAttachment(
      'ATTACHMENT_FILE_MISSING',
      `the file of attachment "${att.name}" is missing from storage`,
    );
  }
}
