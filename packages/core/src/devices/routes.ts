import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { db } from '../db/client.js';
import { devicePlatforms, devices, pairingCodes, projectDevices } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { requireFreshAuth } from '../middleware/require-fresh-auth.js';
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
      createdAt: devices.createdAt,
    })
    .from(devices)
    .where(eq(devices.ownerId, userId))
    .orderBy(desc(devices.pairedAt));
  return c.json(rows);
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

    const [updated] = await db
      .update(devices)
      .set({ name })
      .where(eq(devices.id, id))
      .returning({
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
// already rejects revoked tokens) and removes the device from every project
// pool so it stops appearing in dispatcher candidate lists.
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
      await tx
        .update(devices)
        .set({ status: 'revoked' })
        .where(eq(devices.id, id));
      await tx.delete(projectDevices).where(eq(projectDevices.deviceId, id));
    });

    return c.body(null, 204);
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
    if (!access.role && access.ownerId !== userId) {
      throw forbidden('not a project member');
    }

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
    // stale-detector doesn't flip them offline. ISS-271 added a separate
    // runner registry but the JS Tauri client does not yet send `runner:register`
    // over the Rust WS path, so the device heartbeat is the only signal we
    // have. This keeps the contract: a device that talks to /heartbeat is
    // also runnable by the dispatcher.
    const { runners } = await import('../db/schema.js');
    await db
      .update(runners)
      .set({ lastSeenAt: new Date(), status: 'online', updatedAt: new Date() })
      .where(eq(runners.deviceId, device.id));

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
