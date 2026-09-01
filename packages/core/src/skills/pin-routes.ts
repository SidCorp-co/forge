/**
 * Pin / unpin a project skill — the intentional, permanent divergence marker
 * (ISS-795 §10). Its own router because `studio-routes.ts` is at 151 lines of
 * read surface and this is the only write in the family.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { setSkillPinned } from './pin-service.js';

const paramSchema = z.object({ projectId: z.uuid(), skillId: z.uuid() });

// cm:guard `reason` is required to PIN and meaningless to UNPIN, and the service enforces that with a thrown `BAD_REQUEST:` string rather than a status — so validate it HERE too. Without this refinement the caller's 400 arrives as a 500 from a raw Error, and the one thing a pin must always carry is why someone declared the divergence permanent.
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
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', bodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, skillId } = c.req.valid('param');
    const { pinned, reason } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    try {
      return c.json({
        skill: await setSkillPinned({ projectId, skillId, pinned, reason, actorUserId: userId }),
      });
    } catch (err) {
      // cm:guard a skill id that belongs to ANOTHER project reaches `setSkillPinned` and matches no row, because the UPDATE is keyed on (id, projectId) — it throws `NOT_FOUND:` and that must surface as a 404, not a 500. The path id is what the PAT fence bites on, so answering 404 is also what stops this route being used to probe which skill ids exist elsewhere.
      if (err instanceof Error && err.message.startsWith('NOT_FOUND:')) {
        throw new HTTPException(404, { message: 'skill not found', cause: { code: 'NOT_FOUND' } });
      }
      throw err;
    }
  },
);
