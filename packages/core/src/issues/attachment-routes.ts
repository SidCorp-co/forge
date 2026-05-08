import { zValidator } from '@hono/zod-validator';
import { asc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { Hono as HonoCtor } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { issueAttachments, issues } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import { getStorage, isEnoent } from '../storage/index.js';

const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'text/plain',
  'text/markdown',
]);

const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new HTTPException(400, { message, cause: { code, details } });
const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });
const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.slice(0, 200) || 'file';
}

const issueIdParamSchema = z.object({ id: z.uuid() });
const attachmentIdParamSchema = z.object({ id: z.uuid() });

type IssueRouter = Hono<{ Variables: AuthVars }>;

export function registerIssueAttachmentRoutes(router: IssueRouter): void {
  router.post(
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
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

      const body = await c.req.parseBody();
      const file = body['file'];
      if (!(file instanceof File)) throw badRequest('missing "file" field');
      if (file.size <= 0) throw badRequest('empty file');
      if (file.size > env.UPLOADS_MAX_BYTES) throw badRequest('file too large', 'FILE_TOO_LARGE');
      const mime = file.type || 'application/octet-stream';
      if (!ALLOWED_MIMES.has(mime))
        throw badRequest(`mime not allowed: ${mime}`, 'MIME_NOT_ALLOWED');

      const name = safeName(file.name || 'file');
      const buffer = Buffer.from(await file.arrayBuffer());
      const key = `issues/${issue.id}/${Date.now()}-${name}`;
      const { path: storedPath } = await getStorage().put(key, buffer, mime);

      const [inserted] = await db
        .insert(issueAttachments)
        .values({
          issueId: issue.id,
          uploaderId: userId,
          name,
          path: storedPath,
          mime,
          size: file.size,
        })
        .returning({
          id: issueAttachments.id,
          issueId: issueAttachments.issueId,
          uploaderId: issueAttachments.uploaderId,
          name: issueAttachments.name,
          mime: issueAttachments.mime,
          size: issueAttachments.size,
          createdAt: issueAttachments.createdAt,
        });
      if (!inserted) throw new Error('issue_attachments: insert returned no row');

      void safeRecordActivity({
        issueId: issue.id,
        actor: { type: 'user', id: userId },
        action: 'issue.attachment.uploaded',
        payload: {
          attachmentId: inserted.id,
          name: inserted.name,
          mime: inserted.mime,
          size: inserted.size,
        },
      });

      return c.json(
        {
          ...inserted,
          url: `/api/attachments/${inserted.id}/download`,
        },
        201,
      );
    },
  );

  router.get(
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
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

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
}

export const attachmentRoutes = new HonoCtor<{ Variables: AuthVars }>();
attachmentRoutes.use('*', requireAuth(), assertEmailVerified());

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
    const isMember = !!access.role || access.ownerId === userId;
    if (!isMember) throw forbidden('not a project member');

    const isUploader = row.uploaderId === userId;
    const isOwner = access.ownerId === userId || access.role === 'owner';
    if (!isUploader && !isOwner) throw forbidden('only the uploader or a project owner may delete');

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
