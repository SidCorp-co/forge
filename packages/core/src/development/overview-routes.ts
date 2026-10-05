import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readDevelopmentOverview } from './overview-read.js';

const noQuery = z.strictObject({});

export const developmentOverviewRoutes = new Hono<{ Variables: AuthVars }>();
developmentOverviewRoutes.use('*', requireAuth(), assertEmailVerified());

developmentOverviewRoutes.get(
  '/:id/development/overview',
  zValidator('param', idParamSchema),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    return c.json(await readDevelopmentOverview(projectId, userId ? { userId } : null));
  },
);
