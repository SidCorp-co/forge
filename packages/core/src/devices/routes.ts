import { randomBytes } from 'node:crypto';
import { DEVICE_MACHINE, RUNNER_PROVISION_MACHINE } from '@forge/contracts/runner-machine';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { db } from '../db/client.js';
import {
  devicePlatforms,
  devices,
  pairingCodes,
  projects,
  runnerProvisionStatuses,
  runners,
} from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { transition } from '../lifecycle/transition.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { mintEpochFor } from '../middleware/pat-rest-surface.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { badRequest, forbidden, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { hooks } from '../pipeline/hooks.js';
import { readPluginDesignations, unionPluginDesignations } from '../plugins/designation.js';
import { withDeclaredSource } from '../project-config/source.js';
import { insertRunnerEvent } from '../runners/runner-events.js';
import { annotateDeviceBuilds } from './build-state.js';
import { revokeDeviceCredentials } from './credential.js';
import { DEVICE_LIST_COLUMNS } from './device-columns.js';
import { heartbeatGate, withDeviceGate } from './gate-report.js';
import { heartbeatPatch } from './heartbeat-patch.js';
import {
  deleteDeviceRunners,
  mirrorHeartbeatToRunners,
  patchDeviceRunnerCheckout,
  setRunnerProvisionDetail,
} from '../runners/index.js';
import { deviceProvisionRoutes } from './me-provisions.js';
import { listDeviceAssignments } from './me-runners.js';
import { redeemPairingCode } from './pair.js';
import { refuseDevice } from './refusals.js';
import { heartbeatPool } from './pool-read-report.js';
import { requireHeld, requireOrgCan } from '../permissions/index.js';

const unauth = () =>
  new HTTPException(401, { message: 'unauthenticated', cause: { code: 'UNAUTHENTICATED' } });

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generatePairingCode(): string {
  const bytes = randomBytes(10);
  let chars = '';
  for (let i = 0; i < 10; i++) {
    // biome-ignore lint/style/noNonNullAssertion: randomBytes guarantees byte access
    chars += CROCKFORD_ALPHABET[bytes[i]! & 0x1f];
  }
  return `${chars.slice(0, 2)}-${chars.slice(2, 6)}-${chars.slice(6, 10)}`;
}

const PAIR_CODE_TTL_MS = 5 * 60 * 1000;

const platformEnum = z.enum(devicePlatforms);

const pairBodySchema = z
  .object({
    code: z.string().min(8).max(64),
    name: z.string().min(1).max(80),
    platform: platformEnum,
    agentVersion: z.string().max(80).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    // Stable machine id (e.g. /etc/machine-id). When present, re-pairing from
    // the same machine rotates the existing device row instead of duplicating.
    machineId: z.string().min(1).max(256).optional(),
  })
  .strict();

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
  })
  .strict();

const mintCodeParamSchema = z.object({ id: z.uuid() });

// Public — no auth middleware; device exchanges a pairing code for a token.
export const devicePublicRoutes = new Hono();

devicePublicRoutes.post(
  '/pair',
  rateLimit(() => RULES.devicesPair, { name: 'devices:pair' }),
  zValidator('json', pairBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const result = await redeemPairingCode({
      code: input.code,
      name: input.name,
      platform: input.platform,
      ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
      ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
    });
    return c.json(
      {
        deviceId: result.device.id,
        deviceToken: result.plaintext,
        projectId: result.projectId,
      },
      201,
    );
  },
);

async function ownedDevice(id: string, userId: string) {
  const [device] = await db
    .select({ ownerId: devices.ownerId, status: devices.status })
    .from(devices)
    .where(eq(devices.id, id))
    .limit(1);
  if (!device) throw notFound('device not found');
  if (device.ownerId !== userId) throw forbidden('not the device owner');
  return device;
}

export const deviceOwnerRoutes = new Hono<{ Variables: AuthVars }>();
deviceOwnerRoutes.use('*', requireAuth(), assertEmailVerified());

const ownerDevicesQuery = z.object({ orgId: z.uuid().optional() });

deviceOwnerRoutes.get(
  '/me/devices',
  zValidator('query', ownerDevicesQuery, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    // ISS-477 — optional org scope, NARROWING this owner-scoped list: the filter
    // sits on top of `devices.ownerId`, so the answer is always a subset of the
    // caller's own, and an unassigned box has no runner row and so falls under no
    // org scope at all. The organisation's devices are a different population,
    // served by `/api/orgs/:orgId/devices` in `devices/org-routes.ts` (ISS-1162).
    const { orgId } = c.req.valid('query');
    if (orgId !== undefined) await requireOrgCan({ userId }, 'org.read', orgId);

    const rows = orgId
      ? await db
          .selectDistinct(DEVICE_LIST_COLUMNS)
          .from(devices)
          .innerJoin(runners, eq(runners.deviceId, devices.id))
          .innerJoin(projects, eq(projects.id, runners.projectId))
          .where(and(eq(devices.ownerId, userId), eq(projects.orgId, orgId)))
          .orderBy(desc(devices.pairedAt))
      : await db
          .select(DEVICE_LIST_COLUMNS)
          .from(devices)
          .where(eq(devices.ownerId, userId))
          .orderBy(desc(devices.pairedAt));
    // ISS-392, widened by ISS-1165 — each box is compared against the published
    // release AND the runner head on the default branch. The second is what catches
    // a release that was never cut, where every box reports the number the last one
    // carried and nothing reads as behind.
    const annotated = withDeviceGate(await annotateDeviceBuilds(rows));
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
  zValidator('param', deviceIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', updateDeviceSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { name, disabled } = c.req.valid('json');
    const userId = c.get('userId');

    const device = await ownedDevice(id, userId);
    // A revoked device is gone for good — its token is dead and its runners were
    // deleted; "turn on" can't bring it back (re-pair instead).
    if (disabled === false && device.status === 'revoked') {
      throw refuseDevice('DEVICE_REVOKED', 'device is revoked — re-pair it instead of re-enabling', '/disabled');
    }

    const patch: { name?: string; disabledAt?: Date | null } = {};
    if (name !== undefined) patch.name = name;
    if (disabled !== undefined) patch.disabledAt = disabled ? new Date() : null;

    const [updated] = await db.update(devices).set(patch).where(eq(devices.id, id)).returning({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      status: devices.status,
      disabledAt: devices.disabledAt,
      lastSeenAt: devices.lastSeenAt,
      pairedAt: devices.pairedAt,
    });
    if (!updated) throw notFound('device not found');

    // When toggling on/off, live-refresh the owner's Runners surface + any device
    // room watchers so the badge flips without a manual reload. Best-effort.
    if (disabled !== undefined) {
      try {
        const { roomManager } = await import('../ws/server.js');
        const { deviceRoom, userRoom } = await import('../ws/rooms.js');
        // `device.statusChanged` is the device-state event the web event-router
        // already invalidates ['devices','me'] (+ project health / attention) on.
        const payload = { event: 'device.statusChanged', data: { deviceId: id, disabled } };
        roomManager.publish(userRoom(userId), payload);
        roomManager.publish(deviceRoom(id), payload);
      } catch {
        // Non-fatal: the toggle already committed.
      }
    }

    return c.json(updated);
  },
);

deviceOwnerRoutes.delete(
  '/devices/:id',
  zValidator('param', deviceIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    await ownedDevice(id, userId);

    await db.transaction(async (tx) => {
      await transition(tx, DEVICE_MACHINE, {
        to: 'revoked',
        where: eq(devices.id, id),
        actor: restActor(c),
        source: 'device-revoke',
        returning: ['id'],
      });
      await deleteDeviceRunners(tx, [id]);
    });
    await revokeDeviceCredentials(id);

    try {
      const { roomManager } = await import('../ws/server.js');
      const { deviceRoom, userRoom } = await import('../ws/rooms.js');
      roomManager.publish(userRoom(userId), {
        event: 'device.revoked',
        data: { deviceId: id },
      });
      roomManager.publish(deviceRoom(id), {
        event: 'device.revoked',
        data: { deviceId: id },
      });
    } catch {}

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
  zValidator('param', deviceIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    await ownedDevice(id, userId);

    const rows = await db
      .select({
        runnerId: runners.id,
        projectId: runners.projectId,
        slug: projects.slug,
        name: projects.name,
        repoPath: runners.repoPath,
        branch: runners.branch,
        status: runners.status,
        lastSeenAt: runners.lastSeenAt,
        provisionStatus: runners.provisionStatus,
        provisionDetail: runners.provisionDetail,
        provisionedAt: runners.provisionedAt,
      })
      .from(runners)
      .innerJoin(projects, eq(projects.id, runners.projectId))
      .where(and(eq(runners.deviceId, id), eq(runners.type, 'claude-code')));

    return c.json(await withDeclaredSource(rows));
  },
);

// User-auth — project member mints a pairing code the device will redeem.
export const deviceUserRoutes = new Hono<{ Variables: AuthVars }>();
deviceUserRoutes.use('*', requireAuth(), assertEmailVerified());

deviceUserRoutes.post(
  '/:id/devices/pairing-codes',
  zValidator('param', mintCodeParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');

    // 5-minute TTL, server-minted. Retry on unique-violation (collision).
    const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePairingCode();
      try {
        await db.insert(pairingCodes).values({
          code,
          userId,
          projectId,
          grantEpoch: mintEpochFor(c),
          expiresAt,
        });
        return c.json({ code, expiresAt: expiresAt.toISOString() }, 201);
      } catch (err: unknown) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new HTTPException(500, { message: 'failed to mint pairing code' });
  },
);

// Device-auth — agent reports in every ~30s.
export const deviceAuthRoutes = new Hono<{ Variables: DeviceVars }>();

deviceAuthRoutes.route('/', deviceProvisionRoutes);

deviceAuthRoutes.post(
  '/heartbeat',
  requireDevice(),
  zValidator('json', heartbeatBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const device = c.get('device');
    const input = c.req.valid('json');

    if (device.status === 'revoked') throw unauth();

    const wasOffline = device.status !== 'online';

    const gate = heartbeatGate(input.gate, device.id);

    const [updated] = await db
      .update(devices)
      .set(heartbeatPatch({ ...input, gate: gate.report }, new Date()))
      .where(eq(devices.id, device.id))
      .returning({ id: devices.id });

    if (!updated) throw unauth();
    await transition(db, DEVICE_MACHINE, {
      to: 'online',
      from: 'offline',
      where: eq(devices.id, device.id),
      actor: { type: 'runner', id: device.id },
      source: 'device-heartbeat',
      returning: ['id'],
    });
    const pool = await heartbeatPool(input.pool, device.id);

    const transitioned = await mirrorHeartbeatToRunners(device.id);
    for (const r of transitioned) {
      await insertRunnerEvent(db, {
        runnerId: r.id,
        projectId: r.project_id,
        oldStatus: r.old_status,
        newStatus: 'online',
        reason: 'device_heartbeat',
      });
    }

    if (wasOffline) {
      const { roomManager } = await import('../ws/server.js');
      const { deviceRoom } = await import('../ws/rooms.js');
      roomManager.publish(deviceRoom(device.id), {
        event: 'device.status',
        data: { deviceId: device.id, status: 'online' },
      });
    }

    return c.json({ ok: true, serverTime: new Date().toISOString(), ...gate.ack, ...pool.ack });
  },
);

// ISS-271 — assignment discovery. The runner daemon and CLI use this to learn
// which projects this device is bound to and the server-side repo path/branch,
// so the path no longer has to be hand-typed into config.toml. `requireDevice`
// already 401s on a missing/invalid/revoked token, so no extra auth handling.
deviceAuthRoutes.get('/me/runners', requireDevice(), async (c) => {
  const device = c.get('device');
  if (device.status === 'revoked') throw unauth();
  return c.json(await listDeviceAssignments(device.id));
});

deviceAuthRoutes.get('/me/plugins', requireDevice(), async (c) => {
  const device = c.get('device');
  if (device.status === 'revoked') throw unauth();

  const rows = await db
    .select({ slug: projects.slug, agentConfig: projects.agentConfig })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .where(and(eq(runners.deviceId, device.id), eq(runners.type, 'claude-code')));

  const plugins = unionPluginDesignations(
    rows.map((r) => ({
      slug: r.slug,
      designations: readPluginDesignations(r.agentConfig, r.slug),
    })),
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
  zValidator('param', z.object({ runnerId: z.uuid() }), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', meRunnerPatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked') throw unauth();
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
  zValidator('param', z.object({ runnerId: z.uuid() }), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', provisionStatusSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked') throw unauth();
    const { runnerId } = c.req.valid('param');
    const { status, detail } = c.req.valid('json');

    const mine = and(eq(runners.id, runnerId), eq(runners.deviceId, device.id));
    const runner = await db.transaction(async (tx) => {
      await transition(tx, RUNNER_PROVISION_MACHINE, {
        to: status,
        where: mine,
        reason: detail ?? null,
        actor: { type: 'runner', id: device.id },
        source: 'provision-status',
        returning: ['id'],
      });
      const [row] = await setRunnerProvisionDetail(tx, mine, detail ?? null, status === 'ready');
      return row;
    });

    if (!runner) {
      throw new HTTPException(404, {
        message: 'runner not found',
        cause: { code: 'RUNNER_NOT_FOUND' },
      });
    }

    await hooks.emit('runnerProvisionStatus', {
      projectId: runner.projectId,
      runnerId: runner.id,
      deviceId: device.id,
      status,
      detail: detail ?? null,
    });

    return c.json(runner);
  },
);
