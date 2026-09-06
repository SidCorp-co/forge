import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { memorySources } from '../db/schema.js';
import { EMBEDDING_UNAVAILABLE, EmbeddingUnavailableError } from '../embeddings/index.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { memorySearchStrategies, runMemorySearch } from './search-service.js';

const searchBodySchema = z.object({
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(50).default(10),
  sourceFilter: z.array(z.enum(memorySources)).optional(),
  // cm:edge contract -> packages/core/src/mcp/tools/forge-memory.ts — the MCP tool declares this same schema and nothing type-checks the two against each other; `semantic` is the default on both because its scores are cosine similarity and existing consumers threshold on them, where hybrid and keyword answer RRF ranks and ts_rank. Declaring the field is half the contract: this route validated it and did not forward it to `runMemorySearch` for as long as it existed, so a caller asking for `hybrid` was answered `semantic` and told so (fixed 2026-09-06, ISS-894).
  strategy: z.enum(memorySearchStrategies).default('semantic'),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

export const memorySearchRoutes = new Hono<{ Variables: AuthVars }>();
// cm:edge ordering -> packages/core/src/middleware/rate-limit.ts — `rateLimit` reads the authenticated user to key its bucket, so it MUST be mounted after `requireAuth`; ahead of it `getUserId` finds nothing and the rule falls back to the IP dimension, so every caller behind one address — a whole runner box — shares a single bucket.
memorySearchRoutes.use(
  '/search',
  requireAuth(),
  assertEmailVerified(),
  rateLimit(RULES.memorySearch, { name: 'memory-search' }),
);
memorySearchRoutes.post(
  '/search',
  zValidator('json', searchBodySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');

    await assertProjectAccess(body.projectId, userId, 'viewer');

    let result: Awaited<ReturnType<typeof runMemorySearch>>;
    try {
      result = await runMemorySearch({
        projectId: body.projectId,
        query: body.query,
        topK: body.topK,
        sourceFilter: body.sourceFilter,
        strategy: body.strategy,
        surface: 'web',
      });
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        throw new HTTPException(503, {
          message: 'embeddings service unavailable',
          cause: { code: EMBEDDING_UNAVAILABLE },
        });
      }
      throw err;
    }
    return c.json(result);
  },
);
