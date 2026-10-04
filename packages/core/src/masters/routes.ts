import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readMasterStanding } from './read.js';

const projectParam = z.object({ id: z.uuid() });
const noQuery = z.strictObject({});

export const masterStandingRoutes = new Hono<{ Variables: AuthVars }>();
masterStandingRoutes.use('/:id/masters/standing', requireAuth(), assertEmailVerified());

masterStandingRoutes.get(
  '/:id/masters/standing',
  zValidator('param', projectParam, (r) => {
    if (!r.success) throw badRequest('invalid path: /api/projects/<project uuid>/masters/standing');
  }),
  zValidator('query', noQuery, (r) => {
    if (!r.success) throw queryBadRequest(noQuery, r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    if (!access.role) throw forbidden('not a project member');
    return c.json(await readMasterStanding(projectId));
  },
);
