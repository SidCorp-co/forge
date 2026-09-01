/**
 * A project's Divergence Charter over REST — the machine-readable record of
 * intentional deviations from the default pipeline template (Update Pipeline
 * §5, ISS-795). One charter per project.
 *
 * Mounted under `/api/projects`, which is on the PAT allowlist, so an agent
 * holding a project-scoped token reaches its own charter and no other.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { divergenceCharterEntrySchema } from './divergence-charters.js';
import { readCharter, upsertCharterAtomic } from './divergence-charters-service.js';

const projectIdParamSchema = z.object({ id: z.uuid() });

// cm:guard PUT, never PATCH, and `entries` is required — the write is a FULL REPLACEMENT of the charter's entry list, which is what `upsertCharter` does. A PATCH-shaped verb here would read as "merge these in" and silently drop every entry the caller did not resend.
const charterPutSchema = z
  .object({
    entries: z.array(divergenceCharterEntrySchema),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const divergenceCharterRoutes = new Hono<{ Variables: AuthVars }>();
divergenceCharterRoutes.use('*', requireAuth(), assertEmailVerified());

divergenceCharterRoutes.get(
  '/:id/divergence-charter',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    assertProjectRole(access, 'member', 'not a project member');

    return c.json({ charter: await readCharter(projectId) });
  },
);

divergenceCharterRoutes.put(
  '/:id/divergence-charter',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', charterPutSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { entries, reason } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    const charter = await upsertCharterAtomic({
      projectId,
      entries,
      actor: `human:${userId}`,
      ...(reason !== undefined ? { reason } : {}),
    });

    return c.json({ charter });
  },
);
