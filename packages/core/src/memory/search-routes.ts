import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { RULES } from '../config/rate-limits.js';
import { EMBEDDING_UNAVAILABLE, EmbeddingUnavailableError } from '../integrations/llm/index.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { memorySearchInputSchema, runMemorySearch } from './search-service.js';

export const memorySearchRoutes = new Hono<{ Variables: AuthVars }>();
memorySearchRoutes.use(
  '/search',
  requireAuth(),
  assertEmailVerified(),
  rateLimit(() => RULES.memorySearch, { name: 'memory-search' }),
);
memorySearchRoutes.post('/search', zValidator('json', memorySearchInputSchema), async (c) => {
  const body = c.req.valid('json');
  const userId = c.get('userId');

  await requireCan(actorFor(userId), 'project.read', projectResource(body.projectId));

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
});
