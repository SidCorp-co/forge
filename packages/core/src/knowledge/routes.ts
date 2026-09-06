import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { EMBEDDING_UNAVAILABLE, EmbeddingUnavailableError } from '../embeddings/index.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  deleteKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  upsertKnowledgeEntry,
  upsertKnowledgeInputSchema,
} from './service.js';
import { runUnifiedSearch } from './unified-search.js';

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

// cm:edge contract -> packages/core/src/mcp/tools/forge-knowledge.ts — this body is `forge_knowledge` action=search field-for-field (query, topK, scope, strategy) and must stay so while both call `runUnifiedSearch`: the REST route exists to let a client leave MCP without losing the capability, and a divergence here is a capability the two transports disagree about. `sourceFilter` is deliberately absent from BOTH — it is `POST /api/memory/search`'s, and `runUnifiedSearch` has no such parameter.
const searchBodySchema = z.object({
  query: z.string().trim().min(1).max(4000),
  scope: z.enum(['knowledge', 'memory', 'all']).default('knowledge'),
  topK: z.number().int().min(1).max(50).default(10),
  strategy: z.enum(['semantic', 'keyword', 'hybrid']).default('semantic'),
});

// cm:why POST, not GET: `GET /:id/knowledge/:slug` already owns this path, so a GET here resolves as the slug `search` and answers "knowledge entry not found" (ISS-930 probed it). The method is what keeps the two apart, with no ordering rule to preserve.
knowledgeRoutes.post(
  '/:id/knowledge/search',
  rateLimit(RULES.knowledgeSearch, { name: 'knowledge-search' }),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid project id');
  }),
  zValidator('json', searchBodySchema, (r) => {
    if (!r.success) throw badRequest('invalid body');
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId);

    try {
      const result = await runUnifiedSearch({ projectId: id, ...body });
      return c.json(result);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        throw new HTTPException(503, {
          message: 'embeddings service unavailable',
          cause: { code: EMBEDDING_UNAVAILABLE },
        });
      }
      throw err;
    }
  },
);

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
    // cm:why a knowledge write is `member`, deliberately the same bar as a memory write and not the `writer` role the MCP tool asserts — the two transports differ here, and this is the one that is intended.
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
