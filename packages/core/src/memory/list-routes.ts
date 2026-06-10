import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories, memorySources } from '../db/schema.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { runMemoryGet } from './get-service.js';

const listQuerySchema = paginationSchema.extend({
  projectId: z.uuid(),
  source: z.enum(memorySources).optional(),
});

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
    const { projectId, source, limit, offset } = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectAccess(projectId, userId, 'viewer');

    const { rows, total } = await runMemoryGet({
      projectId,
      ...(source ? { source } : {}),
      limit,
      offset,
      orderBy: 'createdAt',
      orderDir: 'desc',
    });

    setTotalCount(c, total);
    return c.json(rows);
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
