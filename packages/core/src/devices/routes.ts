import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { runnerProvisionStatuses } from '../db/schema.js';
import { readPluginDesignations, unionPluginDesignations } from '../lib/plugin-designation.js';
import { RefusalError } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { forbidden, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';
import { answerCheckoutHead, patchDeviceRunnerCheckout } from '../runners/index.js';
import { heartbeatBinaries, withDeviceBinaries } from './binary-report.js';
import { annotateDeviceBuilds } from './build-state.js';
import { heartbeatDisk, withDeviceDisk } from './disk-report.js';
import { heartbeatGate, withDeviceGate } from './gate-report.js';
import { heartbeatPatch } from './heartbeat-patch.js';
import { deviceProvisionRoutes } from './me-provisions.js';
import { listDeviceAssignments } from './me-runners.js';
import { devicesPorts } from './ports.js';
import { pushDevice } from './push.js';
import {
  deviceOwnership,
  deviceProjectAgentConfigs,
  listDeviceRunners,
  listOwnedDevices,
} from './read.js';
import { refuseDevice } from './refusals.js';
import { recordHeartbeat, reportProvisionStatus, revokeDevice, updateDevice } from './service.js';

const unauth = () =>
  new HTTPException(401, { message: 'unauthenticated', cause: { code: 'UNAUTHENTICATED' } });

const heartbeatBodySchema = z
  .object({
    agentVersion: z.string().max(80).optional(),
    // The commit the running binary was built from. A box that does not send one
    // is not a published build, and is reported as such rather than as current.
    agentCommit: z.string().max(80).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    // Read by `heartbeatGate`, not here: a malformed gate field must not 400 a
    // heartbeat and take the box offline with it (ISS-1192).
    gate: z.unknown().optional(),
    pool: z.unknown().optional(),
    // Read by `heartbeatBinaries`, for the reason `gate` is.
    binaries: z.unknown().optional(),
    // Read by `heartbeatDisk`, for the reason `gate` is.
    disk: z.unknown().optional(),
  })
  .strict();
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

deviceOwnerRoutes.get(
  '/me/devices',
  requireAuth(),
  assertEmailVerified(),
  zValidator('query', ownerDevicesQuery),
  async (c) => {
    const userId = c.get('userId');
    // ISS-477 — optional org scope, NARROWING this owner-scoped list: the filter
    // sits on top of `devices.ownerId`, so the answer is always a subset of the
    // caller's own, and an unassigned box has no runner row and so falls under no
    // org scope at all. The organisation's devices are a different population,
    // served by `/api/orgs/:orgId/devices` in `devices/org-routes.ts` (ISS-1162).
    const { orgId } = c.req.valid('query');
    if (orgId !== undefined) await requireOrgCan(actorFor(userId), 'org.read', orgResource(orgId));

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
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    await ownedDevice(id, userId);

    const rows = await listDeviceRunners(id);

    return c.json(await devicesPorts().withDeclaredSource(rows));
  },
);

// Device-auth — agent reports in every ~30s.
export const deviceAuthRoutes = new Hono<{ Variables: DeviceVars }>();

deviceAuthRoutes.route('/', deviceProvisionRoutes);

deviceAuthRoutes.post(
  '/heartbeat',
  requireDevice(),
  zValidator('json', heartbeatBodySchema),
  async (c) => {
    const device = c.get('device');
    const input = c.req.valid('json');

    const wasOffline = device.status !== 'online';

    const gate = heartbeatGate(input.gate, device.id);
    const binaries = heartbeatBinaries(input.binaries, device.id);
    const disk = heartbeatDisk(input.disk, device);

    const beat = await recordHeartbeat(
      device.id,
      heartbeatPatch(
        { ...input, gate: gate.report, binaries: binaries.report, disk: disk.report },
        new Date(),
      ),
      input.pool,
    );
    if (!beat) throw unauth();

    if (wasOffline) {
      await pushDevice({
        deviceId: device.id,
        userId: null,
        event: 'device.status',
        data: { deviceId: device.id, status: 'online' },
      });
    }

    return c.json({
      ok: true,
      serverTime: new Date().toISOString(),
      ...gate.ack,
      ...binaries.ack,
      ...disk.ack,
      ...beat.poolAck,
    });
  },
);

// ISS-271 — assignment discovery. The runner daemon and CLI use this to learn
// which projects this device is bound to and the server-side repo path/branch,
// so the path no longer has to be hand-typed into config.toml. `requireDevice`
// already 401s on a missing/invalid/revoked token, so no extra auth handling.
deviceAuthRoutes.get('/me/runners', requireDevice(), async (c) => {
  const device = c.get('device');
  return c.json(await listDeviceAssignments(device.id));
});

deviceAuthRoutes.get('/me/plugins', requireDevice(), async (c) => {
  const device = c.get('device');

  const rows = await deviceProjectAgentConfigs(device.id);

  const plugins = unionPluginDesignations(
    rows.map((r) => {
      const read = readPluginDesignations(r.agentConfig, r.slug);
      if (!read.ok) throw new RefusalError([read.refusal], 'PLUGIN_DESIGNATIONS_INVALID');
      return { slug: r.slug, designations: read.designations };
    }),
  );

  return c.json({ plugins });
});

// ISS-271 — device self-service PATCH of its own runner repo path/branch.
// The runner CLI (`forge-runner bind`) holds a device token, not a user JWT,
// so it cannot use the owner/admin PATCH on `projectRoutes`. This endpoint lets
// a device write the SAME `runners.repoPath`/`branch` field web writes, scoped
// to runners that belong to the calling device. 404 if the runner isn't this
// device's.
const meRunnerPatchSchema = z
  .object({
    repoPath: z.string().trim().max(500).nullable().optional(),
    branch: z.string().trim().max(100).nullable().optional(),
  })
  .strict();

deviceAuthRoutes.patch(
  '/me/runners/:runnerId',
  requireDevice(),
  zValidator('param', z.object({ runnerId: z.uuid() })),
  zValidator('json', meRunnerPatchSchema),
  async (c) => {
    const device = c.get('device');
    const { runnerId } = c.req.valid('param');
    const { repoPath, branch } = c.req.valid('json');

    const runner = await patchDeviceRunnerCheckout(device.id, runnerId, { repoPath, branch });

    if (!runner) {
      throw new HTTPException(404, {
        message: 'runner not found',
        cause: { code: 'RUNNER_NOT_FOUND' },
      });
    }

    return c.json(runner);
  },
);

// Device → server provision progress report. Scoped to runners owned by the
// calling device (404 otherwise). Bridges to the project room (live stepper).
const provisionStatusSchema = z
  .object({
    status: z.enum(runnerProvisionStatuses),
    detail: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

deviceAuthRoutes.post(
  '/me/runners/:runnerId/provision-status',
  requireDevice(),
  zValidator('param', z.object({ runnerId: z.uuid() })),
  zValidator('json', provisionStatusSchema),
  async (c) => {
    const device = c.get('device');
    const { runnerId } = c.req.valid('param');
    const { status, detail } = c.req.valid('json');

    const runner = await reportProvisionStatus({
      deviceId: device.id,
      runnerId,
      status,
      detail: detail ?? null,
    });

    if (!runner) {
      throw new HTTPException(404, {
        message: 'runner not found',
        cause: { code: 'RUNNER_NOT_FOUND' },
      });
    }

    return c.json(runner);
  },
);

// Device → server: the head a box read from its bound checkout, answering `checkout.head.read`.
// Settled only for the box it was asked of; the reading is checked in `runners/checkout-head.ts`.
const checkoutHeadAnswerSchema = z
  .object({
    projectId: z.uuid(),
    sha: z.string().max(80).optional(),
    ref: z.string().max(300).optional(),
    readAt: z.string().max(40).optional(),
    via: z.string().max(40).optional(),
    origin: z.string().max(1000).optional(),
    error: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

deviceAuthRoutes.post(
  '/me/checkout-heads/:requestId',
  requireDevice(),
  zValidator('param', z.object({ requestId: z.uuid() })),
  zValidator('json', checkoutHeadAnswerSchema),
  async (c) => {
    const { requestId } = c.req.valid('param');
    const outcome = answerCheckoutHead(c.get('device').id, requestId, c.req.valid('json'));
    if (outcome.ok) return c.json({ settled: true });
    if (outcome.code === 'CHECKOUT_HEAD_NOT_ASKED') {
      throw refuseDevice(
        outcome.code,
        `no head read ${requestId} is waiting on this box: it was never asked, it was asked of another box or project, or the wait ended`,
      );
    }
    if (outcome.code === 'CHECKOUT_HEAD_OTHER_REPOSITORY') {
      throw refuseDevice(outcome.code, `the head read ${requestId} was refused: ${outcome.detail}`);
    }
    throw refuseDevice(
      outcome.code,
      `the head read ${requestId} was answered with what names no head: ${outcome.detail}`,
    );
  },
);

export { installRoutes } from './install-routes.js';
export { deviceLoginRoutes } from './login-routes.js';
export { deviceMcpServerRoutes } from './mcp-servers-routes.js';
export { deviceOrgRoutes } from './org-routes.js';
export { devicePoolRoutes } from './pool-routes.js';
