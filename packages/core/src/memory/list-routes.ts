import { Hono } from 'hono';
import { z } from 'zod';
import { memorySources } from '../db/schema.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { runMemoryGet } from './get-service.js';
import { deleteMemory } from './indexer.js';
import { memoryProject } from './read.js';
import { memoryRevisionsInputSchema, runMemoryRevisions } from './revisions-service.js';
import { deleteMemoryById } from './service.js';

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

const deleteQuerySchema = z.object({
  projectId: z.uuid(),
  source: z.enum(memorySources),
  sourceRef: z.string().min(1).max(512),
});

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

memoryListRoutes.delete('/by-source', zValidator('query', deleteQuerySchema), async (c) => {
  const { projectId, source, sourceRef } = c.req.valid('query');
  const userId = c.get('userId');
  await requireCan(actorFor(userId), 'project.write', projectResource(projectId));

  return c.json({ deleted: await deleteMemory(projectId, source, sourceRef) });
});

memoryListRoutes.delete('/:id', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  // Idempotent delete. Always return 204 for any (id, caller) pair where the
  // caller is not authorised — never reveal whether a memory id exists in a
  // project the caller cannot see. Only members observe an actual delete.
  const projectId = await memoryProject(id);
  if (!projectId) return c.body(null, 204);

  try {
    await requireCan(actorFor(userId), 'project.write', projectResource(projectId));
  } catch {
    return c.body(null, 204);
  }

  await deleteMemoryById(id);
  return c.body(null, 204);
});
