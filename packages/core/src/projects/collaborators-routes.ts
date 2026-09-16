/**
 * The cross-project collaborator matrix over REST.
 *
 * Per-project membership is already `GET /api/projects/:projectId/members`.
 * The only thing that had no route is the fan-out — the people a caller shares
 * ANY project with, and the roles they hold across all of them.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { listCollaborators } from './collaborators-service.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export const collaboratorsMeRoutes = new Hono<{ Variables: AuthVars }>();
collaboratorsMeRoutes.use('/collaborators', requireAuth(), assertEmailVerified());

collaboratorsMeRoutes.get(
  '/collaborators',
  zValidator('query', querySchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const { limit, offset, search } = c.req.valid('query');
    const visibleProjectIds = await loadVisibleProjectIds(c.get('userId'));

    return c.json(
      await listCollaborators({
        visibleProjectIds,
        limit: limit ?? 50,
        offset: offset ?? 0,
        search,
      }),
    );
  },
);
