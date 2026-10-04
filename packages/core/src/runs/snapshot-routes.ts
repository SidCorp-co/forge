// `GET /api/projects/:id/pm/snapshot`, the project digest the forge CLI's `forge_project_pm` reads.

import { Hono } from 'hono';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readPmSnapshot } from './snapshot-read.js';

export const projectSnapshotRoutes = new Hono<{ Variables: AuthVars }>();
projectSnapshotRoutes.use('/:id/pm/snapshot', requireAuth(), assertEmailVerified());

projectSnapshotRoutes.get(
  '/:id/pm/snapshot',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    requireHeld(await loadProjectAccess(id, c.get('userId')), 'project.read');
    return c.json(await readPmSnapshot(id));
  },
);
