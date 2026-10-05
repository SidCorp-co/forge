import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sendStoredAttachment } from '../lib/attachment-headers.js';
import { loadProjectAccess } from '../lib/authz.js';
import { uploadBodyLimit } from '../lib/upload-body-limit.js';
import { type AuthVars, requireAuth, restActor } from '../middleware/auth.js';
import { forbidden, idParamSchema, notFound } from '../middleware/route-errors.js';
import { rawBody, zValidator } from '../middleware/zod-validator.js';
import { holds, requireHeld } from '../permissions/index.js';
import { deleteIssueAttachment, persistIssueAttachment } from './attachment-service.js';
import {
  heldIssue,
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import { getStorage } from './ports.js';
import { attachmentWithProject, listIssueAttachments } from './read-service.js';

const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new HTTPException(400, { message, cause: { code, details } });

const attachmentIdParamSchema = z.object({ id: z.uuid() });

/**
 * Standalone router for issue attachment endpoints.
 *
 * Mounted at `/api/issues` in `index.ts` SEPARATELY from `issueRoutes` so it
 * can use `requireAuth()` alone (user JWT, PAT, or device token) while
 * `issueRoutes` adds `assertEmailVerified`
 * for browser-only endpoints.
 *
 * Hono routes the request to whichever router has a matching handler for
 * the path; `/:id/attachments` only exists here, so PAT/device callers
 * (MCP runners, automation scripts) reach this router directly.
 */
export const issueAttachmentRoutes = new Hono<{ Variables: AuthVars }>();
issueAttachmentRoutes.use('/:id/attachments', requireAuth());

issueAttachmentRoutes.post(
  '/:id/attachments',
  uploadBodyLimit(() => {
    throw badRequest('file too large', 'FILE_TOO_LARGE');
  }),
  zValidator('param', idParamSchema),
  rawBody(
    'multipart/form-data',
    'One file in the `file` field, attached to the issue; its name and media type come from the part.',
  ),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await heldIssue(issueId, userId, 'project.write');

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw badRequest('missing "file" field');
    const buffer = Buffer.from(await file.arrayBuffer());
    const row = await persistIssueAttachment({
      issueId: issue.id,
      name: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      bytes: buffer,
      uploaderId: userId,
      uploaderAgency: restActor(c).agency,
    });
    return c.json(row, 201);
  },
);

issueAttachmentRoutes.get(
  '/:id/attachments',
  zValidator('param', issueRouteIdParamSchema),
  zValidator('query', projectScopeQuerySchema),
  async (c) => {
    const { id: rawId } = c.req.valid('param');
    const { projectId: projectIdQuery } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);

    const rows = await listIssueAttachments(issue.id);

    return c.json(rows.map((r) => ({ ...r, url: `/api/attachments/${r.id}/download` })));
  },
);

/**
 * Standalone router for /api/attachments/:id (download + delete).
 *
 * Same combined-auth as the upload router so automation scripts can pull
 * down attachments they've uploaded (handy for diagnostics).
 */
export const attachmentRoutes = new Hono<{ Variables: AuthVars }>();
attachmentRoutes.use('*', requireAuth());

attachmentRoutes.get('/:id/download', zValidator('param', attachmentIdParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const row = await attachmentWithProject(id);
  if (!row) throw notFound('attachment not found');

  const access = await loadProjectAccess(row.projectId, userId);
  requireHeld(access, 'project.read');

  return sendStoredAttachment(c, row, (path) => getStorage().get(path));
});

attachmentRoutes.delete('/:id', zValidator('param', attachmentIdParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const row = await attachmentWithProject(id);
  if (!row) throw notFound('attachment not found');

  const access = await loadProjectAccess(row.projectId, userId);
  requireHeld(access, 'project.write');

  const isUploader = row.uploaderId === userId;
  const isAdmin = holds(access, 'project.admin');
  if (!isUploader && !isAdmin) throw forbidden('only the uploader or a project admin may delete');

  await getStorage().delete(row.path);
  await deleteIssueAttachment(row, restActor(c));

  return c.body(null, 204);
});
