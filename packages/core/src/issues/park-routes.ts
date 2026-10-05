import type { IssueParkResponse } from '@forge/contracts/park';
import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { heldIssue } from './issue-route-ref.js';
import { loadIssuePark } from './park-view.js';

export const issueParkRoutes = new Hono<{ Variables: AuthVars }>();

issueParkRoutes.use('*', requireAuth(), assertEmailVerified());

/** `GET /api/issues/:id/park` — what a person owes this issue, or `{ park: null }` (ISS-1310). */
issueParkRoutes.get('/:id/park', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  await heldIssue(id, c.get('userId'), 'project.read');
  const body: IssueParkResponse = { park: await loadIssuePark(id) };
  return c.json(body);
});
