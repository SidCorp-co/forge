// `GET /projects/:id/plugin-conflicts` (REQ-26 BC-2): the pins a project cannot have on the boxes it
// shares, read by `plugin-conflicts.ts:readPluginConflicts`.

import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { readPluginConflicts } from './plugin-conflicts.js';

export const projectPluginConflictRoutes = new Hono<{ Variables: AuthVars }>();

projectPluginConflictRoutes.get(
  '/:id/plugin-conflicts',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema),
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => {
    const { id } = c.req.valid('param');
    return c.json({ conflicts: await readPluginConflicts(id) });
  },
);
