import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { gatedRoutes } from '../middleware/gated-routes.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { readDevelopmentOverview } from './overview-read.js';

const noQuery = z.strictObject({});

export const developmentOverviewRoutes = gatedRoutes<{ Variables: AuthVars }>(
  requireAuth(),
  assertEmailVerified(),
);

developmentOverviewRoutes.get(
  '/:id/development/overview',
  zValidator('param', idParamSchema),
  requiresOnParam('project.read', 'id'),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    return c.json(await readDevelopmentOverview(projectId, userId ? { userId } : null));
  },
);
