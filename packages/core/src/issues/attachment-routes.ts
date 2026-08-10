import { zValidator } from '@hono/zod-validator';
import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { issueAttachments, issues } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess, projectRoleAtLeast } from '../lib/authz.js';
import { type AnyAuthVars, requireAnyAuth } from '../middleware/require-any-auth.js';
import { setInertAttachmentHeaders } from '../lib/attachment-headers.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import { getStorage, isEnoent } from '../storage/index.js';
import { AttachmentError, persistIssueAttachment } from './attachment-service.js';

const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new HTTPException(400, { message, cause: { code, details } });
const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });
const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const issueIdParamSchema = z.object({ id: z.uuid() });
const attachmentIdParamSchema = z.object({ id: z.uuid() });

/**
 * Standalone router for issue attachment endpoints.
 *
 * Mounted at `/api/issues` in `index.ts` SEPARATELY from `issueRoutes` so it
 * can use `requireAnyAuth()` (accepts user JWT, PAT, or device token) while
 * `issueRoutes` retains the stricter `requireAuth + assertEmailVerified`
 * for browser-only endpoints.
 *
 * Hono routes the request to whichever router has a matching handler for
 * the path; `/:id/attachments` only exists here, so PAT/device callers
 * (MCP runners, automation scripts) reach this router directly.
 */
export const issueAttachmentRoutes = new Hono<{ Variables: AnyAuthVars }>();
issueAttachmentRoutes.use('*', requireAnyAuth());

issueAttachmentRoutes.post(
  '/:id/attachments',
  bodyLimit({
    maxSize: env.UPLOADS_MAX_BYTES,
    onError: () => {
      throw badRequest('file too large', 'FILE_TOO_LARGE');
    },
  }),
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid id', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'member');

    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) throw badRequest('missing "file" field');
    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      const row = await persistIssueAttachment({
        issueId: issue.id,
        name: file.name || 'file',
        mime: file.type || 'application/octet-stream',
        bytes: buffer,
        uploaderId: userId,
      });
      return c.json(row, 201);
    } catch (err) {
      if (err instanceof AttachmentError) {
        throw badRequest(err.message, err.code);
      }
      throw err;
    }
  },
);

issueAttachmentRoutes.get(
  '/:id/attachments',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid id', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const rows = await db
      .select({
        id: issueAttachments.id,
        issueId: issueAttachments.issueId,
        uploaderId: issueAttachments.uploaderId,
        name: issueAttachments.name,
        mime: issueAttachments.mime,
        size: issueAttachments.size,
        createdAt: issueAttachments.createdAt,
      })
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, issue.id))
      .orderBy(asc(issueAttachments.createdAt));

    return c.json(
      rows.map((r) => ({ ...r, url: `/api/attachments/${r.id}/download` })),
    );
  },
);

/**
 * Standalone router for /api/attachments/:id (download + delete).
 *
 * Same combined-auth as the upload router so automation scripts can pull
 * down attachments they've uploaded (handy for diagnostics).
 */
export const attachmentRoutes = new Hono<{ Variables: AnyAuthVars }>();
attachmentRoutes.use('*', requireAnyAuth());

attachmentRoutes.get(
  '/:id/download',
  zValidator('param', attachmentIdParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid id', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({
        id: issueAttachments.id,
        path: issueAttachments.path,
        mime: issueAttachments.mime,
        name: issueAttachments.name,
        projectId: issues.projectId,
      })
      .from(issueAttachments)
      .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
      .where(eq(issueAttachments.id, id))
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

attachmentRoutes.delete(
  '/:id',
  zValidator('param', attachmentIdParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid id', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({
        id: issueAttachments.id,
        issueId: issueAttachments.issueId,
        uploaderId: issueAttachments.uploaderId,
        name: issueAttachments.name,
        path: issueAttachments.path,
        projectId: issues.projectId,
      })
      .from(issueAttachments)
      .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
      .where(eq(issueAttachments.id, id))
      .limit(1);
    if (!row) throw notFound('attachment not found');

    const access = await loadProjectAccess(row.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    const isUploader = row.uploaderId === userId;
    const isAdmin = projectRoleAtLeast(access.role, 'admin');
    if (!isUploader && !isAdmin) throw forbidden('only the uploader or a project admin may delete');

    await getStorage().delete(row.path);
    await db.delete(issueAttachments).where(eq(issueAttachments.id, id));

    void safeRecordActivity({
      issueId: row.issueId,
      actor: { type: 'user', id: userId },
      action: 'issue.attachment.deleted',
      payload: { attachmentId: row.id, name: row.name },
    });

    return c.body(null, 204);
  },
);
