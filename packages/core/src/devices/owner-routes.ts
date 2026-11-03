import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { forbidden, notFound } from '../middleware/route-errors.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import {
  actorFor,
  orgResource,
  requireOrgCan,
  requiresByRule,
  requiresSelf,
} from '../permissions/index.js';
import { withDeviceBinaries } from './binary-report.js';
import { annotateDeviceBuilds } from './build-state.js';
import { withDeviceDisk } from './disk-report.js';
import { withDeviceGate } from './gate-report.js';
import { devicesPorts } from './ports.js';
import { pushDevice } from './push.js';
import { deviceOwnership, listDeviceRunners, listOwnedDevices } from './read.js';
import { refuseDevice } from './refusals.js';
import { revokeDevice, updateDevice } from './service.js';

const OWN_DEVICE = requiresSelf(
  'the caller acts on a device they own; another’s answers not the device owner',
);

async function ownedDevice(id: string, userId: string) {
  const device = await deviceOwnership(id);
  if (!device) throw notFound('device not found');
  if (device.ownerId !== userId) throw forbidden('not the device owner');
  return device;
}

/**
 * Mounted at `/api`, so each route carries its own guard: a `use('*')` here would run ahead of
 * every `/api` route mounted after this router, whatever that route admits.
 */

export const deviceOwnerRoutes = new Hono<{ Variables: AuthVars }>();

const ownerDevicesQuery = z.object({ orgId: z.uuid().optional() });

/** The caller's own devices, narrowed to an organization's only where the caller reads it (org.read). */
export async function ownerDevicesScope(userId: string, orgId: string | undefined): Promise<void> {
  if (orgId !== undefined) await requireOrgCan(actorFor(userId), 'org.read', orgResource(orgId));
}

deviceOwnerRoutes.get(
  '/me/devices',
  requireAuth(),
  assertEmailVerified(),
  requiresByRule(
    'devices/owner-routes.ts:ownerDevicesScope',
    "the caller's own devices; org.read on the organization the query names, where it names one",
  ),
  zValidator('query', ownerDevicesQuery),
  async (c) => {
    const userId = c.get('userId');
    // ISS-477 — optional org scope, NARROWING this owner-scoped list: the filter
    // sits on top of `devices.ownerId`, so the answer is always a subset of the
    // caller's own, and an unassigned box has no runner row and so falls under no
    // org scope at all. The organisation's devices are a different population,
    // served by `/api/orgs/:orgId/devices` in `devices/org-routes.ts` (ISS-1162).
    const { orgId } = c.req.valid('query');
    await ownerDevicesScope(userId, orgId);

    const rows = await listOwnedDevices(userId, orgId);
    // ISS-392, widened by ISS-1165 — each box is compared against the published
    // release AND the runner head on the default branch. The second is what catches
    // a release that was never cut, where every box reports the number the last one
    // carried and nothing reads as behind.
    const annotated = withDeviceDisk(
      withDeviceBinaries(withDeviceGate(await annotateDeviceBuilds(rows))),
    );
    // Literally true, not defaulted: the WHERE above filters on `devices.ownerId`.
    return c.json(annotated.map((d) => ({ ...d, ownedByMe: true })));
  },
);

const deviceIdParamSchema = z.object({ id: z.uuid() });

const updateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    // Reversible "turn off" switch — true = ignore this device across every
    // project's dispatch + chat; false = re-enable. Distinct from revoke.
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.disabled !== undefined, {
    message: 'provide at least one of `name` or `disabled`',
  });

deviceOwnerRoutes.patch(
  '/devices/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', deviceIdParamSchema),
  OWN_DEVICE,
  zValidator('json', updateDeviceSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { name, disabled } = c.req.valid('json');
    const userId = c.get('userId');

    const device = await ownedDevice(id, userId);
    // A revoked device is gone for good — its token is dead and its runners were
    // deleted; "turn on" can't bring it back (re-pair instead).
    if (disabled === false && device.status === 'revoked') {
      throw refuseDevice(
        'DEVICE_REVOKED',
        'device is revoked — re-pair it instead of re-enabling',
        '/disabled',
      );
    }

    const patch: { name?: string; disabledAt?: Date | null } = {};
    if (name !== undefined) patch.name = name;
    if (disabled !== undefined) patch.disabledAt = disabled ? new Date() : null;

    const updated = await updateDevice(id, patch);
    if (!updated) throw notFound('device not found');

    // When toggling on/off, live-refresh the owner's Runners surface + any device
    // room watchers so the badge flips without a manual reload. Best-effort.
    if (disabled !== undefined) {
      try {
        // `device.statusChanged` is the device-state event the web event-router
        // already invalidates ['devices','me'] (+ project health / attention) on.
        await pushDevice({
          deviceId: id,
          userId,
          event: 'device.statusChanged',
          data: { deviceId: id, disabled },
        });
      } catch {
        // Non-fatal: the toggle already committed.
      }
    }

    return c.json(updated);
  },
);

deviceOwnerRoutes.delete(
  '/devices/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', deviceIdParamSchema),
  OWN_DEVICE,
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    await ownedDevice(id, userId);

    await revokeDevice(id, restActor(c));

    return c.body(null, 204);
  },
);

// ISS-273 — owner-scoped runner discovery for the web device-management page.
// Mirrors the device-token `GET /me/runners` (above) but authed by the user
// JWT and param-scoped to a device the caller owns, so Settings → Devices →
// [device] can list assigned projects with each runner's repo path/branch and
// online/offline status.
deviceOwnerRoutes.get(
  '/devices/:id/runners',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', deviceIdParamSchema),
  OWN_DEVICE,
  noQuery,
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    await ownedDevice(id, userId);

    const rows = await listDeviceRunners(id);

    return c.json(await devicesPorts().withDeclaredSource(rows));
  },
);
