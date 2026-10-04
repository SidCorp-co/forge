/**
 * Pin / unpin a project skill — the intentional, permanent divergence marker
 * (ISS-795 §10). Its own router because `studio-routes.ts` is at 151 lines of
 * read surface and this is the only write in the family.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { setSkillPinned } from './pin-service.js';
import { requireHeld } from '../permissions/index.js';

const paramSchema = z.object({ projectId: z.uuid(), skillId: z.uuid() });

const bodySchema = z
  .object({ pinned: z.boolean(), reason: z.string().trim().min(1).max(2000).optional() })
  .strict()
  .refine((v) => !v.pinned || !!v.reason, {
    message: 'reason is required to pin a skill',
    path: ['reason'],
  });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const skillPinRoutes = new Hono<{ Variables: AuthVars }>();
skillPinRoutes.use('/:projectId/skills/:skillId/pin', requireAuth(), assertEmailVerified());

skillPinRoutes.put(
  '/:projectId/skills/:skillId/pin',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', bodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, skillId } = c.req.valid('param');
    const { pinned, reason } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    try {
      return c.json({
        skill: await setSkillPinned({ projectId, skillId, pinned, reason, actorUserId: userId }),
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NOT_FOUND:')) {
        throw new HTTPException(404, { message: 'skill not found', cause: { code: 'NOT_FOUND' } });
      }
      throw err;
    }
  },
);
