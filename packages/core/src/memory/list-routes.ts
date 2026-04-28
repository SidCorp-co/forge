import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories, memorySources, projectMembers, projects } from '../db/schema.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

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

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

async function assertProjectMember(projectId: string, userId: string): Promise<void> {
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw forbidden('not a project member');
  if (project.ownerId === userId) return;

  const [member] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!member) throw forbidden('not a project member');
}

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
    await assertProjectMember(projectId, userId);

    const conditions = [eq(memories.projectId, projectId)];
    if (source) conditions.push(eq(memories.source, source));
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(memories)
      .where(where);

    const rows = await db
      .select({
        id: memories.id,
        projectId: memories.projectId,
        source: memories.source,
        sourceRef: memories.sourceRef,
        textContent: memories.textContent,
        metadata: memories.metadata,
        embeddedAt: memories.embeddedAt,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .where(where)
      .orderBy(desc(memories.createdAt))
      .limit(limit)
      .offset(offset);

    setTotalCount(c, Number(n));
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
    await assertProjectMember(projectId, userId);

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
      await assertProjectMember(row.projectId, userId);
    } catch {
      return c.body(null, 204);
    }

    await db.delete(memories).where(eq(memories.id, id));
    return c.body(null, 204);
  },
);
