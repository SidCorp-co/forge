// `POST /api/memory/search`: the find door's memory filter (ISS-1256, `find-port.ts`), in the door's
// order, the hits memory's own.

import { Hono } from 'hono';
import { requestReader } from '../lib/authz.js';
import { RULES } from '../lib/rate-limits.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireDeclaredOn, requiresOnResolved } from '../permissions/index.js';
import { recordReached } from '../run-context/index.js';
import { memorySearchInputSchema, memoryThroughFind } from './find-port.js';

export const memorySearchRoutes = new Hono<{ Variables: AuthVars }>();
memorySearchRoutes.use(
  '/search',
  requireAuth(),
  assertEmailVerified(),
  rateLimit(() => RULES.memorySearch, { name: 'memory-search' }),
);
memorySearchRoutes.post(
  '/search',
  zValidator('json', memorySearchInputSchema),
  requiresOnResolved('project.read', 'the project the body names as projectId'),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');

    await requireDeclaredOn(body.projectId, userId, 'project.read');

    const result = await memoryThroughFind({
      projectId: body.projectId,
      query: body.query,
      topK: body.topK,
      sourceFilter: body.sourceFilter,
      reader: requestReader(userId),
    });
    recordReached(c, body.projectId, 'search', { memory: result.hits });
    return c.json(result);
  },
);
