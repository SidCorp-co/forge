/**
 * `POST /api/issues/:id/steer` — the human half of ISS-888 item 2.
 *
 * Transport only. The steer itself lives in
 * `agent-sessions/steer-session.ts` —
 * the ISS-889 rule that a query living in one transport is a second data plane
 * the other cannot reach.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { steerIssue } from '../agent-sessions/steer-session.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';

const steerBodySchema = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const issueSteerRoutes = new Hono<{ Variables: AuthVars }>();

issueSteerRoutes.use('/:id/steer', requireAuth(), assertEmailVerified());

issueSteerRoutes.post(
  '/:id/steer',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success)
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
  }),
  zValidator('json', steerBodySchema, (r) => {
    if (!r.success)
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { body, reason } = c.req.valid('json');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, id))
      .limit(1);
    if (!issue) throw new HTTPException(404, { message: 'issue not found' });

    const access = await loadProjectAccess(issue.projectId, userId);
    requireHeld(access, 'project.write');

    return c.json(
      await steerIssue(id, body, {
        actorUserId: userId,
        actorAgency: restActor(c).agency,
        reason: reason ?? 'steer (REST)',
        source: 'rest',
      }),
    );
  },
);
