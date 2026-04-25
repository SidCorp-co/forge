import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { knowledgeEdges } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectId: z.uuid(),
    subject: z.string().min(1).max(500).optional(),
    predicate: z.string().min(1).max(500).optional(),
    object: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

const createSchema = z
  .object({
    projectId: z.uuid(),
    subject: z.string().min(1).max(500),
    predicate: z.string().min(1).max(500),
    object: z.string().min(1).max(500),
    value: z.string().max(10_000).nullable().optional(),
    sourceMemoryId: z.string().max(500).nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
    validFrom: z.coerce.date().nullable().optional(),
    validUntil: z.coerce.date().nullable().optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const knowledgeEdgeRoutes = new Hono<{ Variables: AuthVars }>();
knowledgeEdgeRoutes.use('*', requireAuth(), assertEmailVerified());

knowledgeEdgeRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, subject, predicate, object, limit } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const conditions: SQL[] = [eq(knowledgeEdges.projectId, projectId)];
    if (subject) conditions.push(eq(knowledgeEdges.subject, subject));
    if (predicate) conditions.push(eq(knowledgeEdges.predicate, predicate));
    if (object) conditions.push(eq(knowledgeEdges.object, object));

    const rows = await db
      .select()
      .from(knowledgeEdges)
      .where(and(...conditions))
      .orderBy(desc(knowledgeEdges.createdAt))
      .limit(limit);

    return c.json(rows);
  },
);

knowledgeEdgeRoutes.post(
  '/',
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(input.projectId, userId);
    if (access.ownerId !== userId && access.role !== 'owner' && access.role !== 'admin') {
      throw forbidden('only project owner or admin can create edges');
    }

    const [inserted] = await db
      .insert(knowledgeEdges)
      .values({
        projectId: input.projectId,
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        value: input.value ?? null,
        sourceMemoryId: input.sourceMemoryId ?? null,
        confidence: input.confidence ?? 1.0,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
      })
      .returning();
    if (!inserted) throw new Error('knowledge_edges: insert returned no row');

    return c.json(inserted, 201);
  },
);

knowledgeEdgeRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({ id: knowledgeEdges.id, projectId: knowledgeEdges.projectId })
      .from(knowledgeEdges)
      .where(eq(knowledgeEdges.id, id))
      .limit(1);
    if (!row) throw notFound('knowledge edge not found');

    const access = await loadProjectAccess(row.projectId, userId);
    if (access.ownerId !== userId && access.role !== 'owner') {
      throw forbidden('not a project owner');
    }

    await db.delete(knowledgeEdges).where(eq(knowledgeEdges.id, id));
    return c.body(null, 204);
  },
);

