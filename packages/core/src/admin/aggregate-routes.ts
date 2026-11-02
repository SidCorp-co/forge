/**
 * Admin cross-tenant aggregate endpoints for the Operator Ops Console (Step 1,
 * ISS-651): GET /overview, /adoption, /workspaces. Each declares its own
 * instance-admin check (ISS-824) so this router can be imported standalone in a
 * vitest suite. The reads live in `read.ts`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requiresInstanceAdmin } from '../permissions/index.js';
import { readAdminAdoption, readAdminOverview, readAdminWorkspaces } from './read.js';
import { GLANCE_WINDOWS } from './types.js';

const overviewQuerySchema = z.object({ window: z.enum(GLANCE_WINDOWS).default('24h') });

export const adminAggregateRoutes = new Hono<{ Variables: AuthVars }>();
adminAggregateRoutes.use('*', requireAuth(), assertEmailVerified());

const ACROSS_TENANTS = requiresInstanceAdmin(
  'a rollup across every tenant of this Forge instance, no project in particular',
);

adminAggregateRoutes.get(
  '/overview',
  ACROSS_TENANTS,
  zValidator('query', overviewQuerySchema),
  async (c) => {
    const { window } = c.req.valid('query');
    return c.json(await readAdminOverview(window));
  },
);

const adoptionQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(52).default(12),
  bucket: z.enum(['week', 'day']).default('week'),
});

adminAggregateRoutes.get(
  '/adoption',
  ACROSS_TENANTS,
  zValidator('query', adoptionQuerySchema),
  async (c) => {
    const { weeks, bucket } = c.req.valid('query');
    return c.json(await readAdminAdoption(weeks, bucket));
  },
);

const workspacesQuerySchema = z.object({
  window: z.enum(GLANCE_WINDOWS).default('7d'),
  sort: z.enum(['runs', 'spend', 'leadTime']).default('runs'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

adminAggregateRoutes.get(
  '/workspaces',
  ACROSS_TENANTS,
  zValidator('query', workspacesQuerySchema),
  async (c) => {
    const { window, sort, limit } = c.req.valid('query');
    const { rows, total } = await readAdminWorkspaces(window, sort, limit);
    return c.json(listResponse(c, rows, total, { limit, offset: 0 }));
  },
);
