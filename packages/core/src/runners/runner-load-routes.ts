// `GET /api/projects/:id/pm/runner-load`, the runner load the forge CLI's `forge_project_pm` reads.

import { Hono } from 'hono';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readRunnerLoad } from './runner-load-read.js';

export const runnerLoadRoutes = new Hono<{ Variables: AuthVars }>();
runnerLoadRoutes.use('/:id/pm/runner-load', requireAuth(), assertEmailVerified());

runnerLoadRoutes.get('/:id/pm/runner-load', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  requireHeld(await loadProjectAccess(id, c.get('userId')), 'project.read');
  return c.json(await readRunnerLoad(id));
});
