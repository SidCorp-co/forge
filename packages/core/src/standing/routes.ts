import { Hono } from 'hono';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { openStandings } from './read.js';

export const standingRoutes = new Hono<{ Variables: AuthVars }>();
standingRoutes.use('/:id/standings', requireAuth(), assertEmailVerified());

/** Every open item's standing, stuck first: the read every surface and the steward take (REQ-48 BC-8). */
standingRoutes.get(
  '/:id/standings',
  zValidator('param', idParamSchema, invalid('invalid path: /api/projects/<project>/standings')),
  noQuery,
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const agency = c.get('agency');
    if (!agency) throw new Error('standings: a request reached its handler without an auth gate');
    requireHeld(await loadProjectAccess(projectId, c.get('userId')), 'project.read');
    const standings = await openStandings(projectId);
    return c.json(
      await egressForRequest(agency, projectId, 'issue', { standings }, 'the project standings'),
    );
  },
);
