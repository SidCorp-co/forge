import {
  PROJECT_STATUS_DAYS_DEFAULT,
  PROJECT_STATUS_DAYS_MAX,
  PROJECT_STATUS_QUERY_SHAPE,
} from '@forge/contracts/project-status';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readProjectStatus, statusViewerOf } from './read.js';

const statusQuery = z.strictObject({
  days: z.coerce.number().int().min(1).max(PROJECT_STATUS_DAYS_MAX).optional(),
});

export const projectStatusRoutes = new Hono<{ Variables: AuthVars }>();
projectStatusRoutes.use('/:id/status', requireAuth(), assertEmailVerified());

projectStatusRoutes.get(
  '/:id/status',
  zValidator('param', idParamSchema, invalid('invalid path: /api/projects/<project>/status')),
  zValidator('query', statusQuery, invalid(`invalid query: ${PROJECT_STATUS_QUERY_SHAPE}`)),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const agency = c.get('agency');
    if (!agency)
      throw new Error('project status: a request reached its handler without an auth gate');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    const read = await readProjectStatus(
      projectId,
      statusViewerOf(access, userId, agency),
      c.req.valid('query').days ?? PROJECT_STATUS_DAYS_DEFAULT,
    );
    return c.json(await egressForRequest(agency, projectId, 'issue', read, 'the project status'));
  },
);
