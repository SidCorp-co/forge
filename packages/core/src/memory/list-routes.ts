import { Hono } from 'hono';
import { z } from 'zod';
import { memorySources } from '../db/schema.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { runMemoryGet } from './get-service.js';
import { memoryRevisionsInputSchema, runMemoryRevisions } from './revisions-service.js';

const listQuerySchema = paginationSchema.extend({
  projectId: z.uuid(),
  source: z.enum(memorySources).optional(),
  sourceRef: z.string().trim().min(1).max(512).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const revisionsQuerySchema = memoryRevisionsInputSchema
  .omit({ limit: true, offset: true })
  .extend(paginationSchema.shape);

export const memoryListRoutes = new Hono<{ Variables: AuthVars }>();
memoryListRoutes.use('*', requireAuth(), assertEmailVerified());

memoryListRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const { projectId, source, sourceRef, limit, offset, includeArchived } = c.req.valid('query');
  const userId = c.get('userId');
  await requireCan(actorFor(userId), 'project.read', projectResource(projectId));

  const { rows, total } = await runMemoryGet({
    projectId,
    ...(source ? { source } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    includeArchived,
    limit,
    offset,
    orderBy: 'createdAt',
    orderDir: 'desc',
  });

  return c.json(listResponse(c, rows, total, { limit, offset }));
});

memoryListRoutes.get('/revisions', zValidator('query', revisionsQuerySchema), async (c) => {
  const { projectId, memoryId, source, sourceRef, limit, offset } = c.req.valid('query');
  const userId = c.get('userId');
  await requireCan(actorFor(userId), 'project.read', projectResource(projectId));

  const { rows, total } = await runMemoryRevisions({
    projectId,
    ...(memoryId ? { memoryId } : {}),
    ...(source ? { source } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    limit,
    offset,
  });

  return c.json(listResponse(c, rows, total, { limit, offset }));
});
