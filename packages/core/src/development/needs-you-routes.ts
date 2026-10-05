import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { needsYouViewerOf, readNeedsYou } from './needs-you.js';

const noQuery = z.strictObject({});

export const needsYouRoutes = new Hono<{ Variables: AuthVars }>();
needsYouRoutes.use('/:id/needs-you', requireAuth(), assertEmailVerified());

needsYouRoutes.get(
  '/:id/needs-you',
  zValidator('param', idParamSchema, (r) => {
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
    requireHeld(access, 'project.read');
    return c.json(await readNeedsYou(projectId, needsYouViewerOf(access, userId, agency)));
  },
);
