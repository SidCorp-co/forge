// `GET /api/issues/:id/lane` (REQ-39 BC-8): the lane the issue's approved change takes, decided by
// the files it touches, and each file the full lane caught with the rule that caught it, so the
// issue says why a change took the long way. Any member of the project may read it.

import { Hono } from 'hono';
import { z } from 'zod';
import { resolveIssueRouteRef } from '../issues/index.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { issueLane } from './service.js';

export const issueLaneRoutes = new Hono<{ Variables: AuthVars }>();
issueLaneRoutes.use('/:id/lane', requireAuth(), assertEmailVerified());

issueLaneRoutes.get(
  '/:id/lane',
  zValidator('param', z.object({ id: z.string().min(1) })),
  zValidator('query', z.object({ projectId: z.uuid().optional() })),
  async (c) => {
    const issue = await resolveIssueRouteRef(
      c.req.valid('param').id,
      c.req.valid('query').projectId,
      c.get('userId'),
    );
    return c.json(await issueLane({ id: issue.id, projectId: issue.projectId }));
  },
);
