import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories, memorySources } from '../db/schema.js';
import { assertProjectAccess } from '../lib/authz.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { runMemoryGet } from './get-service.js';
import { memoryRevisionsInputSchema, runMemoryRevisions } from './revisions-service.js';

const listQuerySchema = paginationSchema.extend({
  projectId: z.uuid(),
  source: z.enum(memorySources).optional(),
  // cm:guard ISS-876 every field `runMemoryGet` filters on must be declared here — zValidator STRIPS an undeclared key silently, so `?sourceRef=x` used to return the whole store with `total` counting every row and no error, which reads as "nothing matched that ref" only if you never look at the count
  sourceRef: z.string().trim().min(1).max(512).optional(),
  // cm:guard a query string carries no boolean — the literal must be parsed here, or `?includeArchived=true` arrives as the truthy string "true" on every request and the archived rows leak into the default read
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

// cm:guard DERIVED from the service's own input schema, not retyped beside it — that is what the sibling list route above learned the hard way: `zValidator` strips a filter the query schema never declared, so `?sourceRef=x` answered with the whole store under a `total` that reads as a match. A filter added to `runMemoryRevisions` is declared here by construction; the query's own `limit`/`offset` come from `paginationSchema` because a query string carries strings.
const revisionsQuerySchema = memoryRevisionsInputSchema
  .omit({ limit: true, offset: true })
  .extend(paginationSchema.shape);

const deleteQuerySchema = z.object({
  projectId: z.uuid(),
  source: z.enum(memorySources),
  sourceRef: z.string().min(1).max(512),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const memoryListRoutes = new Hono<{ Variables: AuthVars }>();
memoryListRoutes.use('*', requireAuth(), assertEmailVerified());

memoryListRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, source, sourceRef, limit, offset, includeArchived } = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectAccess(projectId, userId, 'viewer');

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
  },
);

// cm:edge sideeffect -> packages/core/drizzle/migrations/0208_memory_revisions.sql — every row this route reads is written by the `memories_record_replacement` trigger and by no TypeScript at all, so a reader who greps for the INSERT that fills this table finds none and concludes the route answers empty by design
memoryListRoutes.get(
  '/revisions',
  zValidator('query', revisionsQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, memoryId, source, sourceRef, limit, offset } = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectAccess(projectId, userId, 'viewer');

    const { rows, total } = await runMemoryRevisions({
      projectId,
      ...(memoryId ? { memoryId } : {}),
      ...(source ? { source } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      limit,
      offset,
    });

    return c.json(listResponse(c, rows, total, { limit, offset }));
  },
);

memoryListRoutes.delete(
  '/by-source',
  zValidator('query', deleteQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, source, sourceRef } = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectAccess(projectId, userId);

    const result = await db
      .delete(memories)
      .where(
        and(
          eq(memories.projectId, projectId),
          eq(memories.source, source),
          eq(memories.sourceRef, sourceRef),
        ),
      )
      .returning({ id: memories.id });

    return c.json({ deleted: result.length });
  },
);

const idParamSchema = z.object({ id: z.uuid() });

memoryListRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    // Idempotent delete. Always return 204 for any (id, caller) pair where the
    // caller is not authorised — never reveal whether a memory id exists in a
    // project the caller cannot see. Only members observe an actual delete.
    const [row] = await db
      .select({ projectId: memories.projectId })
      .from(memories)
      .where(eq(memories.id, id))
      .limit(1);
    if (!row) return c.body(null, 204);

    try {
      await assertProjectAccess(row.projectId, userId);
    } catch {
      return c.body(null, 204);
    }

    await db.delete(memories).where(eq(memories.id, id));
    return c.body(null, 204);
  },
);
