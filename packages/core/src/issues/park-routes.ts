import type { IssueParkResponse } from '@forge/contracts';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { loadIssuePark } from './park-view.js';
import { issueScopeOf } from './read-service.js';
import { requireHeld } from '../permissions/index.js';

export const issueParkRoutes = new Hono<{ Variables: AuthVars }>();

issueParkRoutes.use('*', requireAuth(), assertEmailVerified());

/** `GET /api/issues/:id/park` — what a person owes this issue, or `{ park: null }` (ISS-1310). */
issueParkRoutes.get(
  '/:id/park',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: result.error },
      });
    }
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const issue = await issueScopeOf(id);
    if (!issue) {
      throw new HTTPException(404, { message: 'issue not found', cause: { code: 'NOT_FOUND' } });
    }
    const access = await loadProjectAccess(issue.projectId, c.get('userId'));
    requireHeld(access, 'project.read');
    const body: IssueParkResponse = { park: await loadIssuePark(id) };
    return c.json(body);
  },
);
