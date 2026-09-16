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
  ALWAYS_INJECT_GUARANTEE_NOTE,
  ALWAYS_INJECT_MAX_CHARS,
} from '../projects/project-facts.js';
import {
  deleteKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  slugSchema,
  upsertKnowledgeEntry,
  upsertKnowledgeInputSchema,
} from './service.js';
import { runUnifiedSearch } from './unified-search.js';

const idParamSchema = z.object({ id: z.uuid() });
/**
 * The slug is validated here rather than only on the way to the database, and
 * every route below matches it as `:slug{.+}` so that a slug carrying a slash
 * REACHES this schema. Matched as a single path segment, `convention/some-rule`
 * matched no route at all and came back as a bare routing 404 — which reads as
 * "there is no such entry" when the truth is "that is not a slug", and sent at
 * least one run off to file a defect against a store that was behaving. A wrong
 * input is refused by name, with the rule it broke.
 */
const slugParamSchema = z.object({ id: z.uuid(), slug: slugSchema });

const listQuerySchema = z.object({
  kind: z
    .enum(['overview', 'scenario', 'workflow', 'rule', 'guide', 'reference', 'glossary'])
    .optional(),
  injection: z.enum(['always', 'on_demand', 'none']).optional(),
});

const badRequest = (message: string) => new HTTPException(400, { message });
const badSlug = (slug: string) =>
  badRequest(
    `"${slug}" is not a knowledge slug: a slug is kebab-case — lower-case letters and digits separated by hyphens, starting with a letter or digit, at most 512 characters — and carries no slash, so there are no nested slugs. A path like "convention/my-rule" is not an entry that is hard to reach, it is a name this store cannot hold; write it as "convention-my-rule". Memory documents DO carry slash-separated source refs and are a different store, reached through forge_memory rather than forge_knowledge.`,
  );
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
    // The budget and the guarantee travel with the list because this response is
    // what the editor for these rows is built on. Both used to be served by
    // `GET /projects/:id/project-facts` to the Project Facts tab; that tab and
    // that route are gone (ISS-1048) and the obligation moved with the flag.
    return c.json({
      ...result,
      maxAlwaysInjectChars: ALWAYS_INJECT_MAX_CHARS,
      alwaysInjectGuarantee: ALWAYS_INJECT_GUARANTEE_NOTE,
    });
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
  '/:id/knowledge/:slug{.+}',
  zValidator('param', slugParamSchema, (r, c) => {
    if (!r.success) throw badSlug(c.req.param('slug') ?? '');
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
  '/:id/knowledge/:slug{.+}',
  zValidator('param', slugParamSchema, (r, c) => {
    if (!r.success) throw badSlug(c.req.param('slug') ?? '');
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
  '/:id/knowledge/:slug{.+}',
  zValidator('param', slugParamSchema, (r, c) => {
    if (!r.success) throw badSlug(c.req.param('slug') ?? '');
  }),
  async (c) => {
    const { id, slug } = c.req.valid('param');
    const userId = c.get('userId');
    await assertProjectAccess(id, userId);

    const removed = await deleteKnowledgeEntry(id, slug);
    return c.json({ deleted: removed > 0 });
  },
);
