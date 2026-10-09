import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readNeedsYou } from './needs-you.js';
import { readNeedsYouDecisions } from './needs-you-decisions.js';
import { needsYouViewerOf } from './needs-you-viewer.js';

const noQuery = z.strictObject({});

export const needsYouRoutes = new Hono<{ Variables: AuthVars }>();
needsYouRoutes.use('/:id/needs-you', requireAuth(), assertEmailVerified());
needsYouRoutes.use('/:id/needs-you/decisions', requireAuth(), assertEmailVerified());

needsYouRoutes.get(
  '/:id/needs-you',
  zValidator(
    'param',
    idParamSchema,
    invalid('invalid path: /api/projects/<project uuid>/needs-you'),
  ),
  zValidator('query', noQuery),
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

// The needs-me read (REQ-41 BC-1, BC-2): the same rows, as the decisions only a person can make.
needsYouRoutes.get(
  '/:id/needs-you/decisions',
  zValidator(
    'param',
    idParamSchema,
    invalid('invalid path: /api/projects/<project uuid>/needs-you/decisions'),
  ),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const agency = c.get('agency');
    if (!agency) throw new Error('needs-you: a request reached its handler without an auth gate');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    return c.json(await readNeedsYouDecisions(projectId, needsYouViewerOf(access, userId, agency)));
  },
);
