/**
 * A project's Divergence Charter over REST — the machine-readable record of
 * intentional deviations from the default pipeline template (Update Pipeline
 * §5, ISS-795). One charter per project.
 *
 * Mounted under `/api/projects`, which is on the PAT allowlist, so an agent
 * holding a project-scoped token reaches its own charter and no other.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  readCharterSchema,
  readDivergenceCharter,
  saveDivergenceCharter,
  savedCharterSchema,
} from './divergence-charter-routes-reference.js';
import { divergenceCharterEntrySchema } from './divergence-charters.js';
import { readCharter, upsertCharterAtomic } from './divergence-charters-service.js';

const projectIdParamSchema = z.object({ id: z.uuid() });

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
  readDivergenceCharter,
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    assertProjectRole(access, 'member', 'not a project member');

    return c.json(answer(readCharterSchema, { charter: await readCharter(projectId) }));
  },
);

divergenceCharterRoutes.put(
  '/:id/divergence-charter',
  saveDivergenceCharter,
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

    return c.json(answer(savedCharterSchema, { charter }));
  },
);
