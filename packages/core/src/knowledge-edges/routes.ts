import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { knowledgeEdgeProject, listKnowledgeEdges } from './read.js';
import { createKnowledgeEdge, deleteKnowledgeEdge } from './service.js';

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

export const knowledgeEdgeRoutes = new Hono<{ Variables: AuthVars }>();
knowledgeEdgeRoutes.use('*', requireAuth(), assertEmailVerified());

knowledgeEdgeRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, subject, predicate, object, limit } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    return c.json(await listKnowledgeEdges({ projectId, subject, predicate, object, limit }));
  },
);

knowledgeEdgeRoutes.post(
  '/',
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(input.projectId, userId);
    requireHeld(access, 'project.admin');

    const { row, created } = await createKnowledgeEdge(input);
    return c.json(row, created ? 201 : 200);
  },
);

knowledgeEdgeRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const projectId = await knowledgeEdgeProject(id);
    if (!projectId) throw notFound('knowledge edge not found');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    await deleteKnowledgeEdge(id);
    return c.body(null, 204);
  },
);
