import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { qaRatings } from '../db/schema.js';
import { loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { type ProjectPermission, requireHeld } from '../permissions/index.js';
import { findProjectIdBySlug } from '../projects/service.js';
import {
  chatLogById,
  flaggedChatLogs,
  listChatLogs,
  projectSlugsOf,
  recentChatLogs,
} from './read.js';
import { rateChatLog } from './service.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectSlug: z.string().min(1).max(200).optional(),
    source: z.string().min(1).max(100).optional(),
    qaRating: z.enum(qaRatings).optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const recentQuerySchema = z
  .object({
    projectSlug: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const flaggedQuerySchema = z
  .object({
    projectSlug: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const patchSchema = z
  .object({
    qaRating: z.enum(qaRatings).nullable().optional(),
    qaNotes: z.string().max(10_000).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

async function assertChatLogAccess(
  projectSlug: string,
  userId: string,
  permission: ProjectPermission = 'project.read',
): Promise<void> {
  const projectId = await findProjectIdBySlug(projectSlug);
  if (!projectId) throw notFound('project not found');
  requireHeld(await loadProjectAccess(projectId, userId), permission);
}

export const chatLogRoutes = new Hono<{ Variables: AuthVars }>();
chatLogRoutes.use('*', requireAuth(), assertEmailVerified());

chatLogRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectSlug, source, qaRating, dateFrom, dateTo, page, pageSize } =
      c.req.valid('query');
    const userId = c.get('userId');

    let projectSlugs: string[] | null = null;
    if (projectSlug) {
      await assertChatLogAccess(projectSlug, userId);
    } else {
      // Cross-project view: restrict to caller-visible projects (explicit
      // membership at any role, or org owner/admin) via the single authz
      // resolver.
      const visibleIds = await loadVisibleProjectIds(userId);
      if (visibleIds.length === 0) {
        return c.json(listResponse(c, [], 0, fromPage(page, pageSize)));
      }
      projectSlugs = await projectSlugsOf(visibleIds);
      if (projectSlugs.length === 0) {
        return c.json(listResponse(c, [], 0, fromPage(page, pageSize)));
      }
    }

    const offset = (page - 1) * pageSize;
    const { rows, total } = await listChatLogs(
      { projectSlug, projectSlugs, source, qaRating, dateFrom, dateTo },
      { limit: pageSize, offset },
    );

    return c.json(listResponse(c, rows, total, { limit: pageSize, offset }));
  },
);

chatLogRoutes.get(
  '/recent',
  zValidator('query', recentQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectSlug, limit } = c.req.valid('query');
    const userId = c.get('userId');

    await assertChatLogAccess(projectSlug, userId);

    const rows = await recentChatLogs(projectSlug, limit);

    return c.json(
      rows.map((r) => ({
        ...r,
        reply: r.reply && r.reply.length > 500 ? `${r.reply.slice(0, 500)}…` : r.reply,
      })),
    );
  },
);

chatLogRoutes.get(
  '/flagged',
  zValidator('query', flaggedQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectSlug, limit } = c.req.valid('query');
    const userId = c.get('userId');

    await assertChatLogAccess(projectSlug, userId);

    const rows = await flaggedChatLogs(projectSlug, limit);

    return c.json(rows);
  },
);

chatLogRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const row = await chatLogById(id);
    if (!row) throw notFound('chat log not found');

    await assertChatLogAccess(row.projectSlug, userId);
    return c.json(row);
  },
);

chatLogRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', patchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const row = await chatLogById(id);
    if (!row) throw notFound('chat log not found');

    await assertChatLogAccess(row.projectSlug, userId, 'project.admin');

    const updated = await rateChatLog(id, {
      ...(patch.qaRating !== undefined ? { qaRating: patch.qaRating } : {}),
      ...(patch.qaNotes !== undefined ? { qaNotes: patch.qaNotes } : {}),
    });
    if (!updated) throw notFound('chat log not found');

    return c.json(updated);
  },
);
