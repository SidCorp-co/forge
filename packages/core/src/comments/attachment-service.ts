import { asc, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { commentAttachments, comments } from '../db/schema.js';
import { getStorage } from '../storage/index.js';
import type { CommentAttachmentLite } from './tree.js';

export const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
]);

export function safeName(name: string): string {
  // Strip path separators; keep extension. Length-cap.
  const cleaned = name.replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.slice(0, 200) || 'file';
}

export class AttachmentError extends Error {
  readonly code: 'MIME_NOT_ALLOWED' | 'FILE_TOO_LARGE' | 'EMPTY_FILE' | 'INVALID_NAME';
  constructor(
    code: 'MIME_NOT_ALLOWED' | 'FILE_TOO_LARGE' | 'EMPTY_FILE' | 'INVALID_NAME',
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'AttachmentError';
  }
}

export interface PersistCommentAttachmentInput {
  commentId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  uploaderId: string;
  uploaderDeviceId: string | null;
}

export interface PersistedCommentAttachment {
  id: string;
  commentId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: Date;
  url: string;
}

/**
 * Validate + store a single comment attachment. Shared by the REST multipart
 * route and the MCP `forge_comments` create path. Behaviour must stay
 * byte-identical to the legacy inline REST code so the web UI keeps rendering
 * MCP-uploaded rows the same way (see ISS-93 AC #4).
 */
export async function persistCommentAttachment(
  input: PersistCommentAttachmentInput,
): Promise<PersistedCommentAttachment> {
  const { commentId, mime, bytes, uploaderId, uploaderDeviceId } = input;
  if (bytes.byteLength <= 0) {
    throw new AttachmentError('EMPTY_FILE', 'empty file');
  }
  if (bytes.byteLength > env.UPLOADS_MAX_BYTES) {
    throw new AttachmentError('FILE_TOO_LARGE', 'file too large');
  }
  if (!ALLOWED_MIMES.has(mime)) {
    throw new AttachmentError('MIME_NOT_ALLOWED', `mime not allowed: ${mime}`);
  }
  const name = safeName(input.name || 'file');
  if (!name) {
    throw new AttachmentError('INVALID_NAME', 'name is empty after sanitisation');
  }

  const key = `comments/${commentId}/${Date.now()}-${name}`;
  const { path: storedPath } = await getStorage().put(key, bytes, mime);

  const [inserted] = await db
    .insert(commentAttachments)
    .values({
      commentId,
      uploaderId,
      uploaderDeviceId,
      name,
      path: storedPath,
      mime,
      size: bytes.byteLength,
    })
    .returning({
      id: commentAttachments.id,
      commentId: commentAttachments.commentId,
      name: commentAttachments.name,
      mime: commentAttachments.mime,
      size: commentAttachments.size,
      createdAt: commentAttachments.createdAt,
    });
  if (!inserted) throw new Error('comment_attachments: insert returned no row');

  return {
    ...inserted,
    url: `/api/comments/attachments/${inserted.id}`,
  };
}

/**
 * Group every attachment on an issue's comments by commentId. Shared by the
 * REST comment-tree endpoint (`comments/routes.ts`) and the MCP read surfaces
 * (`forge_comments.list`, `forge_step_start`) so all three render the same
 * `{id,name,mime,size,url,createdAt}` rows from one query. Comments with no
 * attachment simply have no map entry (caller defaults to `[]`).
 */
export async function listCommentAttachmentsForIssue(
  issueId: string,
): Promise<Map<string, CommentAttachmentLite[]>> {
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
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .where(eq(comments.issueId, issueId))
    .orderBy(asc(commentAttachments.createdAt));

  const byCommentId = new Map<string, CommentAttachmentLite[]>();
  for (const a of rows) {
    const list = byCommentId.get(a.commentId) ?? [];
    list.push({
      id: a.id,
      name: a.name,
      mime: a.mime,
      size: a.size,
      createdAt: a.createdAt,
      url: `/api/comments/attachments/${a.id}`,
    });
    byCommentId.set(a.commentId, list);
  }
  return byCommentId;
}
