import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readDevelopmentOverview } from './overview-read.js';

const projectParam = z.object({ id: z.uuid() });
const noQuery = z.strictObject({});

export const developmentOverviewRoutes = new Hono<{ Variables: AuthVars }>();
developmentOverviewRoutes.use('*', requireAuth(), assertEmailVerified());

developmentOverviewRoutes.get(
  '/:id/development/overview',
  zValidator('param', projectParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', noQuery, (r) => {
    if (!r.success) throw queryBadRequest(noQuery, r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    return c.json(await readDevelopmentOverview(projectId, userId ? { userId } : null));
  },
);
