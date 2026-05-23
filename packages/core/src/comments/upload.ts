import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { commentAttachments, comments, issues } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AnyAuthVars, requireAnyAuth } from '../middleware/require-any-auth.js';
import { getStorage, isEnoent } from '../storage/index.js';
import { AttachmentError, persistCommentAttachment } from './attachment-service.js';

function attachmentErrorToHttp(err: AttachmentError): HTTPException {
  switch (err.code) {
    case 'FILE_TOO_LARGE':
      return new HTTPException(400, {
        message: 'file too large',
        cause: { code: 'FILE_TOO_LARGE' },
      });
    case 'MIME_NOT_ALLOWED':
      return new HTTPException(400, {
        message: err.message,
        cause: { code: 'MIME_NOT_ALLOWED' },
      });
    case 'EMPTY_FILE':
      return new HTTPException(400, { message: 'empty file', cause: { code: 'BAD_REQUEST' } });
    case 'INVALID_NAME':
      return new HTTPException(400, { message: err.message, cause: { code: 'BAD_REQUEST' } });
  }
}

const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new HTTPException(400, { message, cause: { code, details } });
const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });
const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const commentIdParamSchema = z.object({ commentId: z.uuid() });
const idParamSchema = z.object({ id: z.uuid() });

/**
 * Comment attachment endpoints. Accepts user JWT (web upload), PAT, or
 * device token (MCP runners post screenshots from forge-clarify / forge-test
 * / forge-review).
 */
export const commentUploadRoutes = new Hono<{ Variables: AnyAuthVars }>();
commentUploadRoutes.use('*', requireAnyAuth());

commentUploadRoutes.post(
  '/:commentId/attachments',
  // Reject the request before parseBody buffers the entire payload — this
  // caps memory regardless of file size.
  bodyLimit({
    maxSize: env.UPLOADS_MAX_BYTES,
    onError: () => {
      throw badRequest('file too large', 'FILE_TOO_LARGE');
    },
  }),
  zValidator('param', commentIdParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid commentId', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { commentId } = c.req.valid('param');
    const userId = c.get('userId');

    const [comment] = await db
      .select({ id: comments.id, issueId: comments.issueId, projectId: issues.projectId })
      .from(comments)
      .innerJoin(issues, eq(issues.id, comments.issueId))
      .where(eq(comments.id, commentId))
      .limit(1);
    if (!comment) throw notFound('comment not found');

    const access = await loadProjectAccess(comment.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) throw badRequest('missing "file" field');
    const mime = file.type || 'application/octet-stream';
    const buffer = Buffer.from(await file.arrayBuffer());

    let persisted;
    try {
      persisted = await persistCommentAttachment({
        commentId: comment.id,
        name: file.name || 'file',
        mime,
        bytes: buffer,
        uploaderId: userId,
        uploaderDeviceId: null,
      });
    } catch (err) {
      if (err instanceof AttachmentError) throw attachmentErrorToHttp(err);
      throw err;
    }

    return c.json(persisted, 201);
  },
);

commentUploadRoutes.get(
  '/attachments/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid id', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

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
    if (!row) throw notFound('attachment not found');

    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    let buffer: Buffer;
    try {
      buffer = await getStorage().get(row.path);
    } catch (err) {
      if (isEnoent(err)) {
        throw new HTTPException(410, {
          message: 'attachment file missing on disk',
          cause: { code: 'ATTACHMENT_FILE_MISSING' },
        });
      }
      throw err;
    }
    c.header('Content-Type', row.mime);
    c.header('Content-Disposition', `inline; filename="${row.name}"`);
    return c.body(new Uint8Array(buffer));
  },
);
