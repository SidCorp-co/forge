import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { commentAttachments, comments, issues } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
]);

const badRequest = (message: string, code = 'BAD_REQUEST') =>
  new HTTPException(400, { message, cause: { code } });
const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });
const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

function safeName(name: string): string {
  // Strip path separators; keep extension. Length-cap.
  const cleaned = name.replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.slice(0, 200) || 'file';
}

export const commentUploadRoutes = new Hono<{ Variables: AuthVars }>();
commentUploadRoutes.use('*', requireAuth(), assertEmailVerified());

commentUploadRoutes.post('/:commentId/attachments', async (c) => {
  const commentId = c.req.param('commentId');
  if (!/^[0-9a-f-]{36}$/i.test(commentId)) throw badRequest('invalid commentId');
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
  if (file.size <= 0) throw badRequest('empty file');
  if (file.size > env.UPLOADS_MAX_BYTES) throw badRequest('file too large', 'FILE_TOO_LARGE');
  const mime = file.type || 'application/octet-stream';
  if (!ALLOWED_MIMES.has(mime)) throw badRequest(`mime not allowed: ${mime}`, 'MIME_NOT_ALLOWED');

  const name = safeName(file.name || 'file');
  const dir = resolve(env.UPLOADS_DIR, comment.projectId, comment.id);
  await mkdir(dir, { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  const diskPath = join(dir, `${Date.now()}-${name}`);
  await writeFile(diskPath, buffer);

  const [inserted] = await db
    .insert(commentAttachments)
    .values({
      commentId: comment.id,
      uploaderId: userId,
      name,
      path: diskPath,
      mime,
      size: file.size,
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

  return c.json(
    {
      ...inserted,
      url: `/api/comments/attachments/${inserted.id}`,
    },
    201,
  );
});

commentUploadRoutes.get('/attachments/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('invalid id');
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

  const buffer = await readFile(row.path);
  c.header('Content-Type', row.mime);
  c.header('Content-Disposition', `inline; filename="${row.name}"`);
  return c.body(new Uint8Array(buffer));
});
