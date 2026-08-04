// Resolve an attachment's storage path + display metadata across the three
// attachment tables. Kept separate from `mcp/tools/forge-uploads.ts` (which has
// its own richer loader for the inline path) so the unauthenticated download
// route does not have to import the MCP tool layer.

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
import type { DownloadTargetType } from './download-ticket-service.js';

export interface AttachmentBytesTarget {
  name: string;
  mime: string;
  size: number;
  path: string;
  projectId: string;
}

export async function loadAttachmentBytesTarget(
  target: DownloadTargetType,
  attachmentId: string,
): Promise<AttachmentBytesTarget | null> {
  if (target === 'session') {
    const [row] = await db
      .select({
        name: sessionAttachments.name,
        mime: sessionAttachments.mime,
        size: sessionAttachments.size,
        path: sessionAttachments.path,
        projectId: agentSessions.projectId,
      })
      .from(sessionAttachments)
      .innerJoin(agentSessions, eq(agentSessions.id, sessionAttachments.sessionId))
      .where(eq(sessionAttachments.id, attachmentId))
      .limit(1);
    return row ?? null;
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
    return row ?? null;
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
  return row ?? null;
}
