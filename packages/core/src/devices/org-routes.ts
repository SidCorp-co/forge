/**
 * `GET /api/orgs/:orgId/devices` — the organisation's devices, whoever paired
 * them, over `loadVisibleProjectIds` intersected with the org: the set the
 * Overview's runner figure is taken over, so both answer for one project set.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { loadVisibleProjectIds } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { annotateDeviceBuilds } from './build-state.js';
import { listOrgDevices } from './read.js';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';

const orgIdParamSchema = z.object({ orgId: z.uuid() });

export const deviceOrgRoutes = new Hono<{ Variables: AuthVars }>();

deviceOrgRoutes.get(
  '/:orgId/devices',
  zValidator('param', orgIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');
    await requireOrgCan(actorFor(userId), 'org.read', orgResource(orgId));

    const visibleIds = await loadVisibleProjectIds(userId);
    if (visibleIds.length === 0) return c.json([]);

    const rows = await listOrgDevices(orgId, visibleIds);

    const annotated = await annotateDeviceBuilds(rows);
    return c.json(
      annotated.map(({ ownerId, ...device }) => ({ ...device, ownedByMe: ownerId === userId })),
    );
  },
);
