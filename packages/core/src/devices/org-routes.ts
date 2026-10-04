/**
 * `GET /api/orgs/:orgId/devices` — the organisation's devices, whoever paired
 * them, over `loadVisibleProjectIds` intersected with the org: the set the
 * Overview's runner figure is taken over, so both answer for one project set.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { annotateDeviceBuilds } from './build-state.js';
import { requireOrgCan } from '../permissions/index.js';

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
    await requireOrgCan({ userId }, 'org.read', orgId);

    const visibleIds = await loadVisibleProjectIds(userId);
    if (visibleIds.length === 0) return c.json([]);

    // `capabilities` and the gate report are a box's own diagnostics, held back from everyone but
    // its owner. `array_agg` is not DISTINCT: one runner per (project, device, type) by
    // `runners_project_device_type_uq`, so one name per assignment, where DISTINCT would collapse
    // two same-named projects `runnerCount` still counts as two (ISS-1162).
    const rows = await db
      .select({
        id: devices.id,
        name: devices.name,
        platform: devices.platform,
        agentVersion: devices.agentVersion,
        agentCommit: devices.agentCommit,
        status: devices.status,
        disabledAt: devices.disabledAt,
        lastSeenAt: devices.lastSeenAt,
        pairedAt: devices.pairedAt,
        gitCredentialRef: devices.gitCredentialRef,
        createdAt: devices.createdAt,
        ownerId: devices.ownerId,
        runnerCount: sql<number>`count(${runners.id})::int`,
        projectNames: sql<string[]>`array_agg(${projects.name} order by ${projects.name})`,
      })
      .from(devices)
      .innerJoin(runners, eq(runners.deviceId, devices.id))
      .innerJoin(projects, eq(projects.id, runners.projectId))
      .where(and(inArray(projects.id, visibleIds), eq(projects.orgId, orgId)))
      .groupBy(devices.id)
      .orderBy(desc(devices.pairedAt));

    const annotated = await annotateDeviceBuilds(rows);
    return c.json(
      annotated.map(({ ownerId, ...device }) => ({ ...device, ownedByMe: ownerId === userId })),
    );
  },
);
