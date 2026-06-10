import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { memorySources } from '../db/schema.js';
import { EMBEDDING_UNAVAILABLE, EmbeddingUnavailableError } from '../embeddings/index.js';
import { assertProjectMemberAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { runMemorySearch } from './search-service.js';

const searchBodySchema = z.object({
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(50).default(10),
  sourceFilter: z.array(z.enum(memorySources)).optional(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

export const memorySearchRoutes = new Hono<{ Variables: AuthVars }>();
// rateLimit after requireAuth so the bucket keys on the authenticated user.
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

    await assertProjectMemberAccess(body.projectId, userId);

    let result: Awaited<ReturnType<typeof runMemorySearch>>;
    try {
      result = await runMemorySearch({
        projectId: body.projectId,
        query: body.query,
        topK: body.topK,
        sourceFilter: body.sourceFilter,
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
