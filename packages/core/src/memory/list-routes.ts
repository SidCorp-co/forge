import { MEMORY_ENTRY_STATES } from '@forge/contracts/memory';
import { Hono } from 'hono';
import { z } from 'zod';
import { memorySources } from '../db/schema.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { memoryCitesSchema, memoryEntriesInputSchema, readMemoryEntries } from './entries.js';
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

const entriesQuerySchema = paginationSchema.extend({
  projectId: z.uuid(),
  /** Comma-separated sources; absent lists what agents and people wrote down. */
  sources: z
    .string()
    .trim()
    .min(1)
    .transform((v) => v.split(',').map((s) => s.trim()))
    .pipe(z.array(z.enum(memorySources)).min(1))
    .optional(),
  state: z.enum(MEMORY_ENTRY_STATES).optional(),
  cites: memoryCitesSchema.optional(),
});

// MJ-1: memory as a person reads it — who wrote each row and when, whether it was checked, what it
// cites and which of those no longer resolve, why it needs a check, and every person's correction
// or retirement; `counts` sizes each list by the same rule. `cites` keeps the rows naming one
// requirement, issue or workflow: the read its own page shows (REQ-33 BC-4).
memoryListRoutes.get('/entries', zValidator('query', entriesQuerySchema), async (c) => {
  const { projectId, sources, state, cites, limit, offset } = c.req.valid('query');
  const userId = c.get('userId');
  await requireCan(actorFor(userId), 'project.read', projectResource(projectId));

  const { rows, total, counts } = await readMemoryEntries(
    memoryEntriesInputSchema.parse({
      projectId,
      ...(sources ? { sources } : {}),
      ...(state ? { state } : {}),
      ...(cites ? { cites } : {}),
      limit,
      offset,
    }),
  );
  return c.json({ ...listResponse(c, rows, total, { limit, offset }), counts });
});
