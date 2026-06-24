import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { EmbeddingUnavailableError } from '../embeddings/index.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  deleteKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  upsertKnowledgeEntry,
  upsertKnowledgeInputSchema,
} from './service.js';

const idParamSchema = z.object({ id: z.uuid() });
const slugParamSchema = z.object({ id: z.uuid(), slug: z.string().min(1).max(512) });

const listQuerySchema = z.object({
  kind: z
    .enum(['overview', 'scenario', 'workflow', 'rule', 'guide', 'reference', 'glossary'])
    .optional(),
  injection: z.enum(['always', 'on_demand', 'none']).optional(),
});

const badRequest = (message: string) => new HTTPException(400, { message });
const notFound = () => new HTTPException(404, { message: 'knowledge entry not found' });

export const knowledgeRoutes = new Hono<{ Variables: AuthVars }>();
knowledgeRoutes.use('*', requireAuth(), assertEmailVerified());

// GET /api/projects/:id/knowledge — list (member read)
knowledgeRoutes.get(
  '/:id/knowledge',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid project id');
  }),
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest('invalid query params');
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { kind, injection } = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId);

    const result = await listKnowledgeEntries({ projectId: id, kind, injection });
    return c.json(result);
  },
);

// GET /api/projects/:id/knowledge/:slug — full entry (member read)
knowledgeRoutes.get(
  '/:id/knowledge/:slug',
  zValidator('param', slugParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid params');
  }),
  async (c) => {
    const { id, slug } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId);

    const entry = await getKnowledgeEntry(id, slug);
    if (!entry) throw notFound();
    return c.json(entry);
  },
);

// PUT /api/projects/:id/knowledge/:slug — upsert (member write)
const upsertBodySchema = upsertKnowledgeInputSchema.omit({ projectId: true, slug: true });

knowledgeRoutes.put(
  '/:id/knowledge/:slug',
  zValidator('param', slugParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid params');
  }),
  zValidator('json', upsertBodySchema, (r) => {
    if (!r.success) throw badRequest('invalid body');
  }),
  async (c) => {
    const { id, slug } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    // writer-level: same as memory write (member)
    await assertProjectAccess(id, userId);

    try {
      const result = await upsertKnowledgeEntry({ projectId: id, slug, ...body });
      return c.json(result);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        throw new HTTPException(503, {
          message: 'embeddings service unavailable',
          cause: { code: 'EMBEDDING_UNAVAILABLE' },
        });
      }
      throw err;
    }
  },
);

// DELETE /api/projects/:id/knowledge/:slug — delete (member write, idempotent)
knowledgeRoutes.delete(
  '/:id/knowledge/:slug',
  zValidator('param', slugParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid params');
  }),
  async (c) => {
    const { id, slug } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId);

    const removed = await deleteKnowledgeEntry(id, slug);
    return c.json({ deleted: removed > 0 });
  },
);
