import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readApprovals } from './approvals.js';
import { needsYouViewerOf } from './needs-you-viewer.js';

/** The approval inbox: what waits on the viewer's approve-type decision in one project (read-only). */
export const approvalRoutes = new Hono<{ Variables: AuthVars }>();
approvalRoutes.use('/:id/approvals', requireAuth(), assertEmailVerified());

approvalRoutes.get(
  '/:id/approvals',
  zValidator(
    'param',
    idParamSchema,
    invalid('invalid path: /api/projects/<project uuid>/approvals'),
  ),
  zValidator('query', z.strictObject({}), invalid('invalid query: this read takes none')),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const agency = c.get('agency');
    if (!agency) throw new Error('approvals: a request reached its handler without an auth gate');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    return c.json(await readApprovals(projectId, needsYouViewerOf(access, userId, agency), access));
  },
);
