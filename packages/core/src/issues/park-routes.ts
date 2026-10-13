import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { issueParkSchema, readIssuePark } from './park-routes-reference.js';
import { loadIssuePark } from './park-view.js';

const idParamSchema = z.object({ id: z.uuid() });

export const issueParkRoutes = new Hono<{ Variables: AuthVars }>();

issueParkRoutes.use('*', requireAuth(), assertEmailVerified());

/** `GET /api/issues/:id/park` — what a person owes this issue, or `{ park: null }` (ISS-1310). */
issueParkRoutes.get(
  '/:id/park',
  readIssuePark,
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(result.error) },
      });
    }
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const [issue] = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, id))
      .limit(1);
    if (!issue) {
      throw new HTTPException(404, { message: 'issue not found', cause: { code: 'NOT_FOUND' } });
    }
    const access = await loadProjectAccess(issue.projectId, c.get('userId'));
    assertProjectRole(access, 'viewer');
    return c.json(answer(issueParkSchema, { park: await loadIssuePark(id) }));
  },
);
