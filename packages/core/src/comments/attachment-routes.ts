/**
 * Comment attachment endpoints, split out of `routes.ts` on size grounds.
 *
 * Mounted onto `commentRoutes` at the end of that file, so the registration
 * order every path is matched in is exactly what it was. Same doors, same
 * per-route auth: `requireAuth()` here rather than a router-wide wildcard,
 * for the reason the block below states.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getStorage, isEnoent } from '../integrations/index.js';
import { setInertAttachmentHeaders } from '../lib/attachment-headers.js';
import { loadProjectAccess } from '../lib/authz.js';
import { uploadBodyLimit } from '../lib/upload-body-limit.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { forbidden, idParamSchema } from '../middleware/route-errors.js';
import { rawBody, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { persistCommentAttachment } from './attachment-service.js';
import { commentAttachmentFile, issueCommentForAttachment } from './read.js';

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const attachmentBadRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new HTTPException(400, { message, cause: { code, details } });

const commentIdParamSchema = z.object({ commentId: z.uuid() });

export const commentAttachmentRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * Comment attachment endpoints. Accept user JWT (web upload), PAT, or device
 * token (MCP runners post screenshots from forge-clarify / forge-test /
 * forge-review) via `requireAuth()` — deliberately per-route, NOT a
 * router-wide wildcard (see the comment above `commentRoutes`).
 */
commentAttachmentRoutes.post(
  '/:commentId/attachments',
  requireAuth(),
  // Reject the request before parseBody buffers the entire payload — this
  // caps memory regardless of file size.
  uploadBodyLimit(() => {
    throw attachmentBadRequest('file too large', 'FILE_TOO_LARGE');
  }),
  zValidator('param', commentIdParamSchema, (r) => {
    if (!r.success) throw attachmentBadRequest('invalid commentId', 'BAD_REQUEST', r.error);
  }),
  rawBody(
    'multipart/form-data',
    'One file in the `file` field, attached to the comment; its name and media type come from the part.',
  ),
  async (c) => {
    const { commentId } = c.req.valid('param');
    const userId = c.get('userId');

    const comment = await issueCommentForAttachment(commentId);
    if (!comment) throw notFound('comment not found');

    const access = await loadProjectAccess(comment.projectId, userId);
    requireHeld(access, 'project.write');

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw attachmentBadRequest('missing "file" field');
    const mime = file.type || 'application/octet-stream';
    const buffer = Buffer.from(await file.arrayBuffer());

    const persisted = await persistCommentAttachment({
      commentId: comment.id,
      name: file.name || 'file',
      mime,
      bytes: buffer,
      uploaderId: userId,
      uploaderDeviceId: null,
    });

    return c.json(persisted, 201);
  },
);

commentAttachmentRoutes.get(
  '/attachments/:id',
  requireAuth(),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw attachmentBadRequest('invalid id', 'BAD_REQUEST', r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const row = await commentAttachmentFile(id);
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
