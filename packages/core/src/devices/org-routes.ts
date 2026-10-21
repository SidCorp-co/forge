/**
 * `GET /api/orgs/:orgId/devices` — the organization's devices, whoever paired
 * them, over `loadVisibleProjectIds` intersected with the org: the set the
 * Overview's runner figure is taken over, so both answer for one project set;
 * and every live device the organization's own agents hold.
 */

import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { devices, organizationMembers, projects, runners, users } from '../db/schema.js';
import { assertOrgAccess, loadVisibleProjectIds, orgRoleAtLeast } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { annotateDeviceBuilds } from './build-state.js';
import { listOrgDevices, orgDeviceSchema, orgIdParamSchema } from './org-routes-reference.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const deviceOrgRoutes = new Hono<{ Variables: AuthVars }>();

deviceOrgRoutes.get(
  '/:orgId/devices',
  listOrgDevices,
  zValidator('param', orgIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');
    const { role } = await assertOrgAccess(orgId, userId, 'member');

    // The organization's own agents: a box one of them paired is the organization's to see and, for
    // whoever holds the admin role, to revoke, whether or not it serves a project yet (ISS-1229 r23).
    const agents = await db
      .select({ id: users.id, handle: organizationMembers.handle })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.kind, 'agent')));
    const agentHandle = new Map(agents.map((a) => [a.id, a.handle]));
    const manages = orgRoleAtLeast(role, 'admin');

    const visibleIds = await loadVisibleProjectIds(userId);
    if (visibleIds.length === 0 && agents.length === 0) {
      return c.json(answer(z.array(orgDeviceSchema), []));
    }
    const served = visibleIds.length
      ? and(inArray(projects.id, visibleIds), eq(projects.orgId, orgId))
      : sql`false`;
    const heldByAgent =
      agents.length > 0
        ? and(
            inArray(
              devices.ownerId,
              agents.map((a) => a.id),
            ),
            ne(devices.status, 'revoked'),
          )
        : sql`false`;

    // `capabilities` and the gate report are a box's own diagnostics, held back
    // from everyone but its owner. `array_agg` is not DISTINCT: one runner per
    // (project, device, type) by `runners_project_device_type_uq`, so one name
    // per assignment, where DISTINCT would collapse two same-named projects
    // `runnerCount` still counts as two (ISS-1162). A runner on a project outside
    // this set is not counted, so an agent's box serving none of them reads 0.
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
        runnerCount: sql<number>`count(${projects.id})::int`,
        projectNames: sql<
          string[]
        >`coalesce(array_agg(${projects.name} order by ${projects.name}) filter (where ${projects.id} is not null), '{}')`,
      })
      .from(devices)
      .leftJoin(runners, eq(runners.deviceId, devices.id))
      .leftJoin(projects, and(eq(projects.id, runners.projectId), served))
      .where(
        or(
          inArray(
            devices.id,
            db
              .select({ id: runners.deviceId })
              .from(runners)
              .innerJoin(projects, eq(projects.id, runners.projectId))
              .where(served),
          ),
          heldByAgent,
        ),
      )
      .groupBy(devices.id)
      .orderBy(desc(devices.pairedAt));

    const annotated = await annotateDeviceBuilds(rows);
    return c.json(
      answer(
        z.array(orgDeviceSchema),
        annotated.map(({ ownerId, ...device }) => {
          const handle = agentHandle.get(ownerId);
          return {
            ...device,
            ownedByMe: ownerId === userId,
            heldBy: agentHandle.has(ownerId) ? `@${handle ?? 'agent'}` : null,
            canRevoke: ownerId === userId || (manages && agentHandle.has(ownerId)),
          };
        }),
      ),
    );
  },
);
