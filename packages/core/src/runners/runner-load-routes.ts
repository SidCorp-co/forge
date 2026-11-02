// `GET /api/projects/:id/pm/runner-load`, the runner load the forge CLI's `forge_project_pm` reads.

import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { readRunnerLoad } from './runner-load-read.js';

export const runnerLoadRoutes = new Hono<{ Variables: AuthVars }>();
runnerLoadRoutes.use('/:id/pm/runner-load', requireAuth(), assertEmailVerified());

runnerLoadRoutes.get(
  '/:id/pm/runner-load',
  zValidator('param', idParamSchema),
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await readRunnerLoad(id));
  },
);
