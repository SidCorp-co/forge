/**
 * `POST /api/projects/:id/requirements/:req/assistant` — the BA door's way in (ISS-58). It opens the
 * caller's room about one requirement, or hands back the one they already have; talking in it is
 * the ordinary web conversation transport (`POST /api/conversations/:id/messages` and its socket
 * events), which answers a requirement room through the BA persona and tool set.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireCan } from '../permissions/index.js';
import { openRequirementRoom } from './service.js';

export const baDoorRoutes = new Hono<{ Variables: AuthVars }>();

baDoorRoutes.use('/:id/requirements/:req/assistant', requireAuth(), assertEmailVerified());

const param = zValidator(
  'param',
  z.object({ id: z.uuid(), req: z.string().trim().min(1).max(64) }),
  (r) => {
    if (!r.success)
      throw new HTTPException(400, {
        message: 'invalid path: a project uuid and a requirement uuid or key',
        cause: { code: 'BAD_REQUEST' },
      });
  },
);

baDoorRoutes.post('/:id/requirements/:req/assistant', param, async (c) => {
  const { id: projectId, req } = c.req.valid('param');
  const userId = c.get('userId');
  await requireCan({ userId }, 'project.write', projectId);
  const { conversation, reused } = await openRequirementRoom(projectId, req, userId);
  return c.json({ conversation, reused }, reused ? 200 : 201);
});
