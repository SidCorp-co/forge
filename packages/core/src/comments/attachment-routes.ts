/**
 * Comment attachment endpoints, split out of `routes.ts` on size grounds.
 *
 * Mounted onto `commentRoutes` at the end of that file, so the registration
 * order every path is matched in is exactly what it was. Same doors, same
 * per-route auth: `requireAnyAuth()` here rather than a router-wide wildcard,
 * for the reason the block below states.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { commentAttachments, comments, issues } from '../db/schema.js';
import { setInertAttachmentHeaders } from '../lib/attachment-headers.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { uploadBodyLimit } from '../lib/upload-body-limit.js';
import type { AuthVars } from '../middleware/auth.js';
import { requireAnyAuth } from '../middleware/require-any-auth.js';
import { getStorage, isEnoent } from '../storage/index.js';
import { AttachmentError, persistCommentAttachment } from './attachment-service.js';

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const attachmentBadRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new HTTPException(400, { message, cause: { code, details } });

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
        cause: { code: 'MIME_NOT_ALLOWED', details: err.details },
      });
    case 'EMPTY_FILE':
      return new HTTPException(400, { message: 'empty file', cause: { code: 'BAD_REQUEST' } });
    case 'INVALID_NAME':
      return new HTTPException(400, { message: err.message, cause: { code: 'BAD_REQUEST' } });
    case 'ATTACHMENT_NAME_TAKEN':
      return new HTTPException(400, {
        message: err.message,
        cause: { code: 'ATTACHMENT_NAME_TAKEN', details: err.details },
      });
  }
}

const commentIdParamSchema = z.object({ commentId: z.uuid() });
const idParamSchema = z.object({ id: z.uuid() });

export const commentAttachmentRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * Comment attachment endpoints. Accept user JWT (web upload), PAT, or device
 * token (MCP runners post screenshots from forge-clarify / forge-test /
 * forge-review) via `requireAnyAuth()` — deliberately per-route, NOT a
 * router-wide wildcard (see the comment above `commentRoutes`).
 */
commentAttachmentRoutes.post(
  '/:commentId/attachments',
  requireAnyAuth(),
  // Reject the request before parseBody buffers the entire payload — this
  // caps memory regardless of file size.
  uploadBodyLimit(() => {
    throw attachmentBadRequest('file too large', 'FILE_TOO_LARGE');
  }),
  zValidator('param', commentIdParamSchema, (r) => {
    if (!r.success)
      throw attachmentBadRequest('invalid commentId', 'BAD_REQUEST', z.flattenError(r.error));
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
    assertProjectRole(access, 'member');

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw attachmentBadRequest('missing "file" field');
    const mime = file.type || 'application/octet-stream';
    const buffer = Buffer.from(await file.arrayBuffer());

    let persisted: Awaited<ReturnType<typeof persistCommentAttachment>>;
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

commentAttachmentRoutes.get(
  '/attachments/:id',
  requireAnyAuth(),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success)
      throw attachmentBadRequest('invalid id', 'BAD_REQUEST', z.flattenError(r.error));
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
    if (!access.role) throw forbidden('not a project member');

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
    setInertAttachmentHeaders(c, row.mime, row.name);
    return c.body(new Uint8Array(buffer));
  },
);
