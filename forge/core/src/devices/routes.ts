import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { db } from '../db/client.js';
import { devicePlatforms, devices, pairingCodes } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
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
