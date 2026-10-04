import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess, projectRoleAtLeast } from '../lib/authz.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readNeedsYou } from './needs-you-read.js';

const projectParam = z.object({ id: z.uuid() });
const noQuery = z.strictObject({});

export const needsYouRoutes = new Hono<{ Variables: AuthVars }>();
needsYouRoutes.use('/:id/needs-you', requireAuth(), assertEmailVerified());

needsYouRoutes.get(
  '/:id/needs-you',
  zValidator('param', projectParam, (r) => {
    if (!r.success) throw badRequest('invalid path: /api/projects/<project uuid>/needs-you');
  }),
  zValidator('query', noQuery, (r) => {
    if (!r.success) throw queryBadRequest(noQuery, r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const agency = c.get('agency');
    if (!agency) throw new Error('needs-you: a request reached its handler without an auth gate');
    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');
    return c.json(
      await readNeedsYou(projectId, {
        userId,
        agency,
        isAdmin: projectRoleAtLeast(access.role, 'admin'),
      }),
    );
  },
);
