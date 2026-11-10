import { isTimeZone, PROJECT_HOME_QUERY_SHAPE } from '@forge/contracts/project-home';
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
import { requiresOnParam } from '../permissions/index.js';
import { readProjectHome } from './home.js';
import { readProjectStatus, statusViewerOf } from './read.js';

const statusQuery = z.strictObject({
  days: z.coerce.number().int().min(1).max(PROJECT_STATUS_DAYS_MAX).optional(),
});

const homeQuery = z.strictObject({
  tz: z
    .string()
    .max(64)
    .refine(isTimeZone, { error: (i) => `tz ${JSON.stringify(i.input)} is no IANA time zone` })
    .optional(),
});

export const projectStatusRoutes = new Hono<{ Variables: AuthVars }>();
projectStatusRoutes.use('/:id/status', requireAuth(), assertEmailVerified());
projectStatusRoutes.use('/:id/home', requireAuth(), assertEmailVerified());

projectStatusRoutes.get(
  '/:id/status',
  zValidator('param', idParamSchema, invalid('invalid path: /api/projects/<project>/status')),
  requiresOnParam('project.read', 'id'),
  zValidator('query', statusQuery, invalid(`invalid query: ${PROJECT_STATUS_QUERY_SHAPE}`)),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const agency = c.get('agency');
    if (!agency)
      throw new Error('project status: a request reached its handler without an auth gate');
    const access = await loadProjectAccess(projectId, userId);
    const read = await readProjectStatus(
      projectId,
      statusViewerOf(access, userId, agency),
      c.req.valid('query').days ?? PROJECT_STATUS_DAYS_DEFAULT,
    );
    return c.json(await egressForRequest(agency, projectId, 'issue', read, 'the project status'));
  },
);

// The project home's one read (REQ-43 BC-14..BC-18): every figure the home draws, in one request.
projectStatusRoutes.get(
  '/:id/home',
  zValidator('param', idParamSchema, invalid('invalid path: /api/projects/<project>/home')),
  requiresOnParam('project.read', 'id'),
  zValidator('query', homeQuery, invalid(`invalid query: ${PROJECT_HOME_QUERY_SHAPE}`)),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const agency = c.get('agency');
    if (!agency)
      throw new Error('project home: a request reached its handler without an auth gate');
    const access = await loadProjectAccess(projectId, userId);
    const read = await readProjectHome(
      projectId,
      statusViewerOf(access, userId, agency),
      c.req.valid('query').tz ?? 'UTC',
    );
    return c.json(await egressForRequest(agency, projectId, 'issue', read, 'the project home'));
  },
);
