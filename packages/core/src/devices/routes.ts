import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { db } from '../db/client.js';
import { devicePlatforms, devices, pairingCodes, projects, runners } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { requireFreshAuth } from '../middleware/require-fresh-auth.js';
import { insertRunnerEvent } from '../runners/runner-events.js';
import { cmpVersion } from '../install/fetch-release.js';
import { getLatestRunnerVersion } from '../install/routes.js';
import { redeemPairingCode } from './pair.js';

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
    capabilities: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const mintCodeParamSchema = z.object({ id: z.uuid() });

// Public — no auth middleware; device exchanges a pairing code for a token.
export const devicePublicRoutes = new Hono();

devicePublicRoutes.post(
  '/pair',
  rateLimit(RULES.devicesPair, { name: 'devices:pair' }),
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

// User-auth — owner-scoped device management (list / rename / revoke own devices).
export const deviceOwnerRoutes = new Hono<{ Variables: AuthVars }>();
deviceOwnerRoutes.use('*', requireAuth(), assertEmailVerified());

deviceOwnerRoutes.get('/me/devices', async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      agentVersion: devices.agentVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      pairedAt: devices.pairedAt,
      capabilities: devices.capabilities,
      gitCredentialRef: devices.gitCredentialRef,
      createdAt: devices.createdAt,
    })
    .from(devices)
    .where(eq(devices.ownerId, userId))
    .orderBy(desc(devices.pairedAt));
  // ISS-392 — annotate each device with the latest published runner version so
  // the dashboard can flag devices lagging behind. `latestAgentVersion` is null
  // when no release is published (RUNNER_RELEASE_DIR unset / empty); in that
  // case `agentOutdated` is always false (nothing to compare against).
  const latestAgentVersion = await getLatestRunnerVersion();
  const enriched = rows.map((r) => ({
    ...r,
    latestAgentVersion,
    agentOutdated:
      latestAgentVersion !== null &&
      r.agentVersion !== null &&
      cmpVersion(r.agentVersion, latestAgentVersion) < 0,
  }));
  return c.json(enriched);
});

const deviceIdParamSchema = z.object({ id: z.uuid() });

const updateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();

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
    const { name } = c.req.valid('json');
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

    const [updated] = await db.update(devices).set({ name }).where(eq(devices.id, id)).returning({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      pairedAt: devices.pairedAt,
    });
    if (!updated) {
      throw new HTTPException(404, { message: 'device not found', cause: { code: 'NOT_FOUND' } });
    }
    return c.json(updated);
  },
);

// Soft revoke — sets status='revoked' (preserves history; auth middleware
// already rejects revoked tokens) and removes every runner row bound to this
// device so the dispatcher stops considering it. ISS-172 Slice A unified the
// project_devices pool into `runners`, so this is the only cleanup needed.
deviceOwnerRoutes.delete(
  '/devices/:id',
  requireFreshAuth(5),
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
    if (device.ownerId !== userId) throw forbidden('not the device owner');

    await db.transaction(async (tx) => {
      await tx.update(devices).set({ status: 'revoked' }).where(eq(devices.id, id));
      await tx.delete(runners).where(eq(runners.deviceId, id));
    });

    // Live-refresh the owner's Runners surface (and any device room watchers).
    // Best-effort, lazily imported to avoid circular deps at module init.
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
    } catch {
      // Non-fatal: revoke already committed.
    }

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
      })
      .from(runners)
      .innerJoin(projects, eq(projects.id, runners.projectId))
      .where(and(eq(runners.deviceId, id), eq(runners.type, 'claude-code')));

    return c.json(rows);
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
          expiresAt,
        });
        return c.json({ code, expiresAt: expiresAt.toISOString() }, 201);
      } catch (err: unknown) {
        const isUnique =
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code: string }).code === '23505';
        if (!isUnique) throw err;
      }
    }
    throw new HTTPException(500, { message: 'failed to mint pairing code' });
  },
);

// Device-auth — agent reports in every ~30s.
export const deviceAuthRoutes = new Hono<{ Variables: DeviceVars }>();

deviceAuthRoutes.post(
  '/heartbeat',
  requireDevice(),
  zValidator('json', heartbeatBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const device = c.get('device');
    const input = c.req.valid('json');

    // Defence in depth — revoked tokens should never reach here since
    // verifyDeviceToken rejects them.
    if (device.status === 'revoked') throw unauth();

    const wasOffline = device.status !== 'online';

    const [updated] = await db
      .update(devices)
      .set({
        lastSeenAt: new Date(),
        status: 'online',
        ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
        ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
      })
      .where(eq(devices.id, device.id))
      .returning({ id: devices.id });

    if (!updated) throw unauth();

    // Mirror the heartbeat onto any runners bound to this device so the
    // stale-detector doesn't flip them offline. After ISS-172 Slice A a
    // single device may have one runner per project, so this update fans
    // out across every binding.
    //
    // ISS-381 (2.3) — change-gated audit: the `prev` CTE snapshots the status
    // BEFORE the UPDATE, so we can record a runner_events row only for runners
    // that were not already online (the offline→online transition). A
    // steady-state heartbeat updates last_seen_at for all bindings but emits no
    // event, keeping the audit table free of per-tick noise.
    const transitioned = (await db.execute(sql`
      WITH prev AS (
        SELECT id, project_id, status AS old_status
        FROM runners
        WHERE device_id = ${device.id}
      ),
      upd AS (
        UPDATE runners
        SET last_seen_at = now(), status = 'online', updated_at = now()
        WHERE device_id = ${device.id}
        RETURNING id
      )
      SELECT id, project_id, old_status
      FROM prev
      WHERE old_status <> 'online'
    `)) as unknown as Array<{ id: string; project_id: string; old_status: string }> | undefined;
    for (const r of transitioned ?? []) {
      await insertRunnerEvent(db, {
        runnerId: r.id,
        projectId: r.project_id,
        oldStatus: r.old_status,
        newStatus: 'online',
        reason: 'device_heartbeat',
      });
    }

    if (wasOffline) {
      // Best-effort broadcast — import lazily to avoid circular deps at module init.
      const { roomManager } = await import('../ws/server.js');
      const { deviceRoom } = await import('../ws/rooms.js');
      roomManager.publish(deviceRoom(device.id), {
        event: 'device.status',
        data: { deviceId: device.id, status: 'online' },
      });
    }

    return c.json({ ok: true, serverTime: new Date().toISOString() });
  },
);

// ISS-271 — assignment discovery. The runner daemon and CLI use this to learn
// which projects this device is bound to and the server-side repo path/branch,
// so the path no longer has to be hand-typed into config.toml. `requireDevice`
// already 401s on a missing/invalid/revoked token, so no extra auth handling.
deviceAuthRoutes.get('/me/runners', requireDevice(), async (c) => {
  const device = c.get('device');
  if (device.status === 'revoked') throw unauth();

  const rows = await db
    .select({
      projectId: runners.projectId,
      runnerId: runners.id,
      slug: projects.slug,
      baseBranch: projects.baseBranch,
      repoPath: runners.repoPath,
      branch: runners.branch,
      status: runners.status,
    })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .where(and(eq(runners.deviceId, device.id), eq(runners.type, 'claude-code')));

  return c.json(rows);
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

    return c.json(runner);
  },
);
