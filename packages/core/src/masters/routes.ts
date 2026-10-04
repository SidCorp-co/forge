import { MASTER_PASS_PAGE_DEFAULT, MASTER_PASS_PAGE_MAX } from '@forge/contracts/master-standing';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { listMasterPasses, readMasterStanding } from './read.js';

const projectParam = z.object({ id: z.uuid() });
const noQuery = z.strictObject({});
const passQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MASTER_PASS_PAGE_MAX).default(MASTER_PASS_PAGE_DEFAULT),
  before: z.iso.datetime({ offset: true }).optional(),
  sessionId: z.uuid().optional(),
});

export const masterStandingRoutes = new Hono<{ Variables: AuthVars }>();
masterStandingRoutes.use('/:id/masters/standing', requireAuth(), assertEmailVerified());
masterStandingRoutes.use('/:id/masters/passes', requireAuth(), assertEmailVerified());

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
    requireHeld(access, 'project.read');
    return c.json(await readMasterStanding(projectId));
  },
);

masterStandingRoutes.get(
  '/:id/masters/passes',
  zValidator('param', projectParam, (r) => {
    if (!r.success) throw badRequest('invalid path: /api/projects/<project uuid>/masters/passes');
  }),
  zValidator('query', passQuery, (r) => {
    if (!r.success) throw queryBadRequest(passQuery, r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.read');
    const q = c.req.valid('query');
    return c.json(
      await listMasterPasses(projectId, {
        limit: q.limit,
        before: q.before ?? null,
        sessionId: q.sessionId ?? null,
      }),
    );
  },
);

export { deviceMasterRoutes } from './device-routes.js';
