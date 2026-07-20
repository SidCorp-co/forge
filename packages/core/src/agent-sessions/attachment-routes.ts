import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { setInertAttachmentHeaders } from '../lib/attachment-headers.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireUserOrDevice } from '../middleware/auth.js';
import { getStorage, isEnoent } from '../storage/index.js';
import {
  SessionAttachmentError,
  loadSessionAttachment,
  persistSessionAttachment,
} from './attachment-service.js';

function attachmentErrorToHttp(err: SessionAttachmentError): HTTPException {
  switch (err.code) {
    case 'FILE_TOO_LARGE':
      return new HTTPException(400, {
        message: 'file too large',
        cause: { code: 'FILE_TOO_LARGE' },
      });
    case 'MIME_NOT_ALLOWED':
      return new HTTPException(400, { message: err.message, cause: { code: 'MIME_NOT_ALLOWED' } });
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

const sessionIdParamSchema = z.object({ sessionId: z.uuid() });
const downloadParamSchema = z.object({ sessionId: z.uuid(), id: z.uuid() });

/**
 * ISS-499 — agent-chat attachment endpoints. Dual auth (user OR device):
 *  - user (web-v2 composer, cookie/JWT): must be a project member.
 *  - device (a CLI runner downloading a turn's files): may touch ONLY a session
 *    dispatched to it. `loadProjectAccess(_, userId)` fails closed for a device
 *    principal, so we branch explicitly on the principal — same shape the chat
 *    write-back (PATCH /:id) uses.
 */
export const agentSessionAttachmentRoutes = new Hono<{ Variables: AuthVars }>();
agentSessionAttachmentRoutes.use('*', requireUserOrDevice(), assertEmailVerified());

/** Authorize the principal against a session; returns the session row. */
async function authorizeSession(
  c: Context<{ Variables: AuthVars }>,
  sessionId: string,
): Promise<{ id: string; projectId: string; deviceId: string | null }> {
  const [session] = await db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!session) throw notFound('agent session not found');

  if (c.get('principal') === 'device') {
    if (session.deviceId !== c.get('deviceId')) {
      throw forbidden('device does not own this session');
    }
  } else {
    const access = await loadProjectAccess(session.projectId, c.get('userId'));
    assertProjectRole(access, 'member');
  }
  return session;
}

agentSessionAttachmentRoutes.post(
  '/:sessionId/attachments',
  bodyLimit({
    maxSize: env.UPLOADS_MAX_BYTES,
    onError: () => {
      throw badRequest('file too large', 'FILE_TOO_LARGE');
    },
  }),
  zValidator('param', sessionIdParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid sessionId', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    await authorizeSession(c, sessionId);

    // Upload is a user-only action (the web composer). A device principal has no
    // userId, and session_attachments.uploader_id is NOT NULL — reject rather
    // than crash on the insert. Runners only ever GET (download), never POST.
    if (c.get('principal') === 'device') {
      throw forbidden('device principals cannot upload chat attachments');
    }

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw badRequest('missing "file" field');
    const mime = file.type || 'application/octet-stream';
    const buffer = Buffer.from(await file.arrayBuffer());

    try {
      const persisted = await persistSessionAttachment({
        sessionId,
        name: file.name || 'file',
        mime,
        bytes: buffer,
        uploaderId: c.get('userId'),
        uploaderDeviceId: null,
      });
      return c.json(persisted, 201);
    } catch (err) {
      if (err instanceof SessionAttachmentError) throw attachmentErrorToHttp(err);
      throw err;
    }
  },
);

agentSessionAttachmentRoutes.get(
  '/:sessionId/attachments/:id/download',
  zValidator('param', downloadParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid params', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId, id } = c.req.valid('param');
    await authorizeSession(c, sessionId);

    const row = await loadSessionAttachment(id);
    if (!row || row.sessionId !== sessionId) throw notFound('attachment not found');

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
