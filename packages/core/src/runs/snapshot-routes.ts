// `GET /api/projects/:id/pm/snapshot`, the project digest the forge CLI's `forge_project_pm` reads.

import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { readPmSnapshot } from './snapshot-read.js';

export const projectSnapshotRoutes = new Hono<{ Variables: AuthVars }>();
projectSnapshotRoutes.use('/:id/pm/snapshot', requireAuth(), assertEmailVerified());

projectSnapshotRoutes.get(
  '/:id/pm/snapshot',
  zValidator('param', idParamSchema),
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await readPmSnapshot(id));
  },
);
