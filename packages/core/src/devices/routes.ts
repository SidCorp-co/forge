import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { RULES } from '../config/rate-limits.js';
import { db } from '../db/client.js';
import { devices, pairingCodes, projects, runners } from '../db/schema.js';
import { assertOrgAccess, assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { mintEpochFor } from '../middleware/pat-rest-surface.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { hooks } from '../pipeline/hooks.js';
import { readPluginDesignations, unionPluginDesignations } from '../plugins/designation.js';
import { insertRunnerEvent } from '../runners/runner-events.js';
import { annotateDeviceBuilds } from './build-state.js';
import { revokeDeviceCredentials } from './credential.js';
import { DEVICE_LIST_COLUMNS } from './device-columns.js';
import { heartbeatGate, withDeviceGate } from './gate-report.js';
import { heartbeatPatch } from './heartbeat-patch.js';
import { mirrorHeartbeatToRunners } from './heartbeat-runner-mirror.js';
import { deviceProvisionRoutes } from './me-provisions.js';
import { listDeviceAssignments } from './me-runners.js';
import { redeemPairingCode } from './pair.js';
import { heartbeatPool } from './pool-read-report.js';
import { mayRevokeDevice, REVOKE_REFUSAL } from './revoke-authority.js';
import {
  assignmentSchema,
  deviceHeartbeat,
  deviceIdParamSchema,
  deviceRunnerAssignmentSchema,
  deviceStateSchema,
  heartbeatAckSchema,
  heartbeatBodySchema,
  listDeviceRunners,
  listOwnDevices,
  meRunnerPatchSchema,
  mintCodeParamSchema,
  mintedCodeSchema,
  mintPairingCode,
  ownDeviceSchema,
  ownDevicesQuerySchema,
  pairBodySchema,
  pairDevice,
  pairResponseSchema,
  patchOwnRunner,
  pluginsSchema,
  provisionStatusSchema,
  readOwnAssignments,
  readOwnPlugins,
  reportProvisionStatus,
  revokeDevice,
  runnerIdParamSchema,
  runnerPathSchema,
  runnerProvisionedSchema,
  updateDevice,
  updateDeviceSchema,
} from './routes-reference.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

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

// Public — no auth middleware; device exchanges a pairing code for a token.
export const devicePublicRoutes = new Hono();

devicePublicRoutes.post(
  '/pair',
  rateLimit(RULES.devicesPair, { name: 'devices:pair' }),
  pairDevice,
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
      answer(pairResponseSchema, {
        deviceId: result.device.id,
        deviceToken: result.plaintext,
        projectId: result.projectId,
      }),
      201,
    );
  },
);

/**
 * Mounted at `/api`, so each route carries its own guard: a `use('*')` here
 * would run ahead of every `/api` route mounted after this router, whatever
 * that route admits.
 */
export const deviceOwnerRoutes = new Hono<{ Variables: AuthVars }>();

deviceOwnerRoutes.get(
  '/me/devices',
  requireAuth(),
  assertEmailVerified(),
  listOwnDevices,
  zValidator('query', ownDevicesQuerySchema),
  async (c) => {
    const userId = c.get('userId');
    // ISS-477 — optional org scope, NARROWING this owner-scoped list: the filter
    // sits on top of `devices.ownerId`, so the answer is always a subset of the
    // caller's own, and an unassigned box has no runner row and so falls under no
    // org scope at all. The organisation's devices are a different population,
    // served by `/api/orgs/:orgId/devices` in `devices/org-routes.ts` (ISS-1162).
    const { orgId } = c.req.valid('query');
    if (orgId !== undefined) await assertOrgAccess(orgId, userId, 'member');

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
    return c.json(
      answer(
        z.array(ownDeviceSchema),
        annotated.map((d) => ({ ...d, ownedByMe: true as const })),
      ),
    );
  },
);

deviceOwnerRoutes.patch(
  '/devices/:id',
  requireAuth(),
  assertEmailVerified(),
  updateDevice,
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

    const [device] = await db
      .select({ ownerId: devices.ownerId, status: devices.status })
      .from(devices)
      .where(eq(devices.id, id))
      .limit(1);
    if (!device) {
      throw new HTTPException(404, { message: 'device not found', cause: { code: 'NOT_FOUND' } });
    }
    if (device.ownerId !== userId) throw forbidden('not the device owner');
    // A revoked device is gone for good — its token is dead and its runners were
    // deleted; "turn on" can't bring it back (re-pair instead).
    if (disabled === false && device.status === 'revoked') {
      throw forbidden('device is revoked — re-pair it instead of re-enabling');
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
    if (!updated) {
      throw new HTTPException(404, { message: 'device not found', cause: { code: 'NOT_FOUND' } });
    }

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

    return c.json(answer(deviceStateSchema, updated));
  },
);

deviceOwnerRoutes.delete(
  '/devices/:id',
  requireAuth(),
  assertEmailVerified(),
  revokeDevice,
  zValidator('param', deviceIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [device] = await db
      .select({ ownerId: devices.ownerId, status: devices.status })
      .from(devices)
      .where(eq(devices.id, id))
      .limit(1);
    if (!device) {
      throw new HTTPException(404, { message: 'device not found', cause: { code: 'NOT_FOUND' } });
    }
    if (!(await mayRevokeDevice(device.ownerId, userId))) throw forbidden(REVOKE_REFUSAL);

    await db.transaction(async (tx) => {
      await tx.update(devices).set({ status: 'revoked' }).where(eq(devices.id, id));
      await tx.delete(runners).where(eq(runners.deviceId, id));
    });
    await revokeDeviceCredentials(id);

    try {
      const { roomManager } = await import('../ws/server.js');
      const { deviceRoom, userRoom } = await import('../ws/rooms.js');
      for (const room of new Set([userId, device.ownerId])) {
        roomManager.publish(userRoom(room), { event: 'device.revoked', data: { deviceId: id } });
      }
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
// online/offline status. `projectDefaultRepoPath`/`baseBranch` give the UI a
// sensible prefill when a runner has no per-device path set yet.
deviceOwnerRoutes.get(
  '/devices/:id/runners',
  requireAuth(),
  assertEmailVerified(),
  listDeviceRunners,
  zValidator('param', deviceIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [device] = await db
      .select({ ownerId: devices.ownerId })
      .from(devices)
      .where(eq(devices.id, id))
      .limit(1);
    if (!device) {
      throw new HTTPException(404, { message: 'device not found', cause: { code: 'NOT_FOUND' } });
    }
    if (device.ownerId !== userId) throw forbidden('not the device owner');

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
        projectDefaultRepoPath: projects.repoPath,
        baseBranch: projects.baseBranch,
        provisionStatus: runners.provisionStatus,
        provisionDetail: runners.provisionDetail,
        provisionedAt: runners.provisionedAt,
      })
      .from(runners)
      .innerJoin(projects, eq(projects.id, runners.projectId))
      .where(and(eq(runners.deviceId, id), eq(runners.type, 'claude-code')));

    return c.json(answer(z.array(deviceRunnerAssignmentSchema), rows));
  },
);

// User-auth — project member mints a pairing code the device will redeem.
export const deviceUserRoutes = new Hono<{ Variables: AuthVars }>();
deviceUserRoutes.use('*', requireAuth(), assertEmailVerified());

deviceUserRoutes.post(
  '/:id/devices/pairing-codes',
  mintPairingCode,
  zValidator('param', mintCodeParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'member');

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
        return c.json(answer(mintedCodeSchema, { code, expiresAt: expiresAt.toISOString() }), 201);
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
  deviceHeartbeat,
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
      const { publishBoxState } = await import('./box-state-publish.js');
      await publishBoxState(device.id, 'online');
    }

    return c.json(
      answer(heartbeatAckSchema, {
        ok: true,
        serverTime: new Date().toISOString(),
        ...gate.ack,
        ...pool.ack,
      }),
    );
  },
);

// ISS-271 — assignment discovery. The runner daemon and CLI use this to learn
// which projects this device is bound to and the server-side repo path/branch,
// so the path no longer has to be hand-typed into config.toml. `requireDevice`
// already 401s on a missing/invalid/revoked token, so no extra auth handling.
deviceAuthRoutes.get('/me/runners', requireDevice(), readOwnAssignments, async (c) => {
  const device = c.get('device');
  if (device.status === 'revoked') throw unauth();
  return c.json(answer(z.array(assignmentSchema), await listDeviceAssignments(device.id)));
});

deviceAuthRoutes.get('/me/plugins', requireDevice(), readOwnPlugins, async (c) => {
  const device = c.get('device');
  if (device.status === 'revoked') throw unauth();

  const rows = await db
    .select({ slug: projects.slug, agentConfig: projects.agentConfig })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .where(and(eq(runners.deviceId, device.id), eq(runners.type, 'claude-code')));

  const plugins = unionPluginDesignations(
    rows.map((r) => ({ slug: r.slug, designations: readPluginDesignations(r.agentConfig) })),
  );

  return c.json(answer(pluginsSchema, { plugins }));
});

// ISS-271 — device self-service PATCH of its own runner repo path/branch: the runner CLI
// (`forge-runner bind`) holds a device token, so it cannot use the owner PATCH on `projectRoutes`.
// Scoped to runners that belong to the calling device; 404 if the runner isn't this device's.
deviceAuthRoutes.patch(
  '/me/runners/:runnerId',
  requireDevice(),
  patchOwnRunner,
  zValidator('param', runnerIdParamSchema, (r) => {
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

    const [runner] = await db
      .update(runners)
      .set({
        updatedAt: new Date(),
        ...(repoPath !== undefined ? { repoPath } : {}),
        ...(branch !== undefined ? { branch } : {}),
      })
      .where(and(eq(runners.id, runnerId), eq(runners.deviceId, device.id)))
      .returning({
        id: runners.id,
        projectId: runners.projectId,
        deviceId: runners.deviceId,
        repoPath: runners.repoPath,
        branch: runners.branch,
        status: runners.status,
      });

    if (!runner) {
      throw new HTTPException(404, {
        message: 'runner not found',
        cause: { code: 'RUNNER_NOT_FOUND' },
      });
    }

    return c.json(answer(runnerPathSchema, runner));
  },
);

// Device → server provision progress report, scoped to the calling device's runners.
deviceAuthRoutes.post(
  '/me/runners/:runnerId/provision-status',
  requireDevice(),
  reportProvisionStatus,
  zValidator('param', runnerIdParamSchema, (r) => {
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

    const now = new Date();
    const [runner] = await db
      .update(runners)
      .set({
        provisionStatus: status,
        provisionDetail: detail ?? null,
        // The age a stall is read from: only a write of the status moves it (ISS-1359).
        provisionStatusAt: now,
        updatedAt: now,
        ...(status === 'ready' ? { provisionedAt: now } : {}),
      })
      .where(and(eq(runners.id, runnerId), eq(runners.deviceId, device.id)))
      .returning({
        id: runners.id,
        projectId: runners.projectId,
        deviceId: runners.deviceId,
        provisionStatus: runners.provisionStatus,
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

    return c.json(answer(runnerProvisionedSchema, runner));
  },
);
