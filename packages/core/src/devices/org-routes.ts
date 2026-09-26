/**
 * `GET /api/orgs/:orgId/devices` — the organisation's devices, whoever paired
 * them, over `loadVisibleProjectIds` intersected with the org: the same set the
 * Overview's runner figure is taken over in `me/pulse-routes.ts`, because two
 * screens whose numbers reconcile must answer for one project set (ISS-1162).
 */

import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import { assertOrgAccess, loadVisibleProjectIds } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { annotateDeviceBuilds } from './build-state.js';
import { DEVICE_LIST_COLUMNS } from './device-columns.js';
import { withDeviceGate } from './gate-report.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const orgIdParamSchema = z.object({ orgId: z.uuid() });

export const deviceOrgRoutes = new Hono<{ Variables: AuthVars }>();

deviceOrgRoutes.get(
  '/:orgId/devices',
  zValidator('param', orgIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');
    await assertOrgAccess(orgId, userId, 'member');

    const visibleIds = await loadVisibleProjectIds(userId);
    if (visibleIds.length === 0) return c.json([]);

    // Grouped per device: two of the org's projects is two runners and one box,
    // and `runnerCount` is what reconciles the two figures.
    const rows = await db
      .select({
        ...DEVICE_LIST_COLUMNS,
        ownerId: devices.ownerId,
        runnerCount: sql<number>`count(distinct ${runners.id})::int`,
        projectNames: sql<string[]>`array_agg(distinct ${projects.name})`,
      })
      .from(devices)
      .innerJoin(runners, eq(runners.deviceId, devices.id))
      .innerJoin(projects, eq(projects.id, runners.projectId))
      .where(and(inArray(projects.id, visibleIds), eq(projects.orgId, orgId)))
      .groupBy(devices.id)
      .orderBy(desc(devices.pairedAt));

    const annotated = withDeviceGate(await annotateDeviceBuilds(rows));
    return c.json(
      annotated.map(({ ownerId, ...device }) => ({ ...device, ownedByMe: ownerId === userId })),
    );
  },
);
