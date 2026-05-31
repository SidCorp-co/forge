/**
 * ISS-305 — Runner browser-approve device login (OAuth device-authorization
 * flow, cf. `claude login`). Mirrors the desktop pairing flow
 * (`auth/desktop/pairing-routes.ts`) but mints a *device token* (for the
 * headless `forge-runner` CLI) instead of a user JWT, and optionally hands the
 * runner a git push credential so it can push with no manual SSH setup.
 *
 *   1. POST /api/devices/login/init    — the CLI mints a short code; backend
 *                                         hashes + persists it; returns the
 *                                         formatted code + the /pair verify URL.
 *   2. POST /api/devices/login/approve — the browser (cookie-auth) approves a
 *                                         typed/linked code, binding it to the
 *                                         signed-in user.
 *   3. GET  /api/devices/login/poll    — the CLI polls every 2 s; 204 while
 *                                         pending, 200 + {device_token, …} when
 *                                         approved (single-use), 410 when
 *                                         expired or already consumed.
 *
 * Codes are 7 Crockford base32 chars displayed as `XXX-XXXX`. Server stores
 * only sha256(canonical). 10-minute TTL. Live pending→approved is broadcast on
 * the owner's user room so the web Runners surface updates without polling.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { RULES } from '../config/rate-limits.js';
import { db } from '../db/client.js';
import { deviceLoginCodes, users } from '../db/schema.js';
import { logger } from '../logger.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { Sentry } from '../observability/sentry.js';
import { issueOrRotateDeviceTokenByMachine } from '../auth/deviceToken.js';
import { provisionGitCredential } from '../git/provision-credential.js';

type LoginPlatform = 'windows' | 'macos' | 'linux';

export const deviceLoginRoutes = new Hono<{ Variables: AuthVars }>();

// === Constants ===

// Crockford base32 with the easy-to-confuse glyphs removed.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 7;
const LOGIN_TTL_SECONDS = 10 * 60;
const VALID_PLATFORMS: ReadonlySet<string> = new Set(['windows', 'macos', 'linux']);
const MAX_LABEL_LEN = 100;
const MAX_HOSTNAME_LEN = 100;
const MAX_USER_AGENT_LEN = 200;
const MAX_INSERT_RETRIES = 5;

// === Helpers (mirror desktop pairing-routes.ts) ===

/**
 * Crockford-base32 7-char code, rejection-sampled so each glyph is uniform over
 * the 32-symbol alphabet (`b & 0x1f` over 0..255 is exact: 256 % 32 == 0).
 */
function generateCanonical(): string {
  const out: string[] = [];
  while (out.length < CODE_LEN) {
    const buf = randomBytes(CODE_LEN * 2);
    for (let i = 0; i < buf.length && out.length < CODE_LEN; i++) {
      const b = buf[i]!;
      out.push(CROCKFORD_ALPHABET[b & 0x1f]!);
    }
  }
  return out.join('');
}

function formatCode(canonical: string): string {
  return `${canonical.slice(0, 3)}-${canonical.slice(3)}`;
}

function normalizeCode(input: unknown): string {
  if (typeof input !== 'string') {
    throw new HTTPException(400, {
      message: 'invalid pairing_code',
      cause: { code: 'INVALID_PAIRING_CODE' },
    });
  }
  const stripped = input.replace(/[\s-]/g, '').toUpperCase();
  if (stripped.length !== CODE_LEN) {
    throw new HTTPException(400, {
      message: 'invalid pairing_code',
      cause: { code: 'INVALID_PAIRING_CODE' },
    });
  }
  for (const ch of stripped) {
    if (!CROCKFORD_ALPHABET.includes(ch)) {
      throw new HTTPException(400, {
        message: 'invalid pairing_code',
        cause: { code: 'INVALID_PAIRING_CODE' },
      });
    }
  }
  return stripped;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function clientIp(c: import('hono').Context): string | undefined {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header('x-real-ip');
  if (real) return real.trim();
  return undefined;
}

async function publishLoginEvent(
  userId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const { roomManager } = await import('../ws/server.js');
    const { userRoom } = await import('../ws/rooms.js');
    roomManager.publish(userRoom(userId), { event, data });
  } catch (err) {
    logger.error({ err, userId, event }, 'device-login: WS publish failed (non-fatal)');
  }
}

// === 1) POST /login/init ===

deviceLoginRoutes.post(
  '/login/init',
  rateLimit(RULES.desktopPairInit, { name: 'deviceLoginInit' }),
  async (c) => {
    let body: {
      device_label?: unknown;
      device_platform?: unknown;
      device_hostname?: unknown;
      machine_id?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      throw new HTTPException(400, {
        message: 'invalid JSON body',
        cause: { code: 'INVALID_BODY' },
      });
    }

    const deviceLabel = typeof body.device_label === 'string' ? body.device_label.trim() : '';
    const devicePlatform =
      typeof body.device_platform === 'string' ? body.device_platform.trim().toLowerCase() : '';
    const deviceHostnameRaw =
      typeof body.device_hostname === 'string' ? body.device_hostname.trim() : '';

    if (!deviceLabel || deviceLabel.length > MAX_LABEL_LEN) {
      throw new HTTPException(400, {
        message: 'device_label is required (1..100 chars)',
        cause: { code: 'INVALID_BODY' },
      });
    }
    if (!VALID_PLATFORMS.has(devicePlatform)) {
      throw new HTTPException(400, {
        message: 'device_platform must be one of windows|macos|linux',
        cause: { code: 'INVALID_BODY' },
      });
    }
    if (deviceHostnameRaw.length > MAX_HOSTNAME_LEN) {
      throw new HTTPException(400, {
        message: 'device_hostname too long',
        cause: { code: 'INVALID_BODY' },
      });
    }
    const deviceHostname = deviceHostnameRaw || null;
    const machineId =
      typeof body.machine_id === 'string' && body.machine_id.trim()
        ? body.machine_id.trim().slice(0, 256)
        : null;

    const createdIp = clientIp(c) ?? null;
    const uaRaw = c.req.header('user-agent') ?? '';
    const createdUserAgent = uaRaw ? uaRaw.slice(0, MAX_USER_AGENT_LEN) : null;
    const expiresAt = new Date(Date.now() + LOGIN_TTL_SECONDS * 1000);

    let canonical = '';
    let inserted: { id: string }[] = [];
    for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
      canonical = generateCanonical();
      const codeHash = sha256Hex(canonical);
      inserted = await db
        .insert(deviceLoginCodes)
        .values({
          codeHash,
          deviceLabel,
          devicePlatform,
          deviceHostname,
          machineId,
          createdIp,
          createdUserAgent,
          expiresAt,
        })
        .onConflictDoNothing({ target: deviceLoginCodes.codeHash })
        .returning({ id: deviceLoginCodes.id });
      if (inserted.length > 0) break;
    }
    if (inserted.length === 0) {
      logger.error(
        { retries: MAX_INSERT_RETRIES },
        'device login: code generation collided every attempt',
      );
      throw new HTTPException(500, {
        message: 'could not allocate pairing code',
        cause: { code: 'CODE_GENERATION_FAILED' },
      });
    }

    const formatted = formatCode(canonical);
    logger.info(
      { loginCodeId: inserted[0]!.id, platform: devicePlatform },
      'device login: code issued',
    );

    return c.json({
      pairing_code: formatted,
      verify_url: `/pair?code=${encodeURIComponent(formatted)}`,
      expires_at: expiresAt.toISOString(),
    });
  },
);

// === 2) POST /login/approve ===

deviceLoginRoutes.post(
  '/login/approve',
  rateLimit(RULES.desktopApprove, { name: 'deviceLoginApprove' }),
  requireAuth(),
  async (c) => {
    const userId = c.get('userId');

    let body: { pairing_code?: unknown };
    try {
      body = (await c.req.json()) as { pairing_code?: unknown };
    } catch {
      throw new HTTPException(400, {
        message: 'invalid JSON body',
        cause: { code: 'INVALID_BODY' },
      });
    }
    const canonical = normalizeCode(body.pairing_code);
    const codeHash = sha256Hex(canonical);

    const updated = await db
      .update(deviceLoginCodes)
      .set({ approvedUserId: userId, approvedAt: sql`now()` })
      .where(
        and(
          eq(deviceLoginCodes.codeHash, codeHash),
          isNull(deviceLoginCodes.approvedUserId),
          isNull(deviceLoginCodes.consumedAt),
          gt(deviceLoginCodes.expiresAt, sql`now()`),
        ),
      )
      .returning({
        id: deviceLoginCodes.id,
        deviceLabel: deviceLoginCodes.deviceLabel,
        devicePlatform: deviceLoginCodes.devicePlatform,
        deviceHostname: deviceLoginCodes.deviceHostname,
        createdIp: deviceLoginCodes.createdIp,
        createdUserAgent: deviceLoginCodes.createdUserAgent,
        createdAt: deviceLoginCodes.createdAt,
        expiresAt: deviceLoginCodes.expiresAt,
      });

    if (updated.length === 0) {
      // Single error shape across "unknown" / "already approved" / "expired"
      // so we don't leak a brute-force oracle.
      throw new HTTPException(404, {
        message: 'pairing code not found',
        cause: { code: 'PAIRING_CODE_NOT_FOUND' },
      });
    }
    const row = updated[0]!;

    logger.info({ approvedUserId: userId, loginCodeId: row.id }, 'device login: approved');
    await publishLoginEvent(userId, 'device.login', {
      status: 'approved',
      label: row.deviceLabel,
      platform: row.devicePlatform,
    });

    return c.json({
      approved: true,
      device: {
        label: row.deviceLabel,
        platform: row.devicePlatform,
        hostname: row.deviceHostname,
        created_ip: row.createdIp,
        created_user_agent: row.createdUserAgent,
        created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        expires_at: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
      },
    });
  },
);

// === 3) GET /login/poll ===

deviceLoginRoutes.get('/login/poll', async (c) => {
  const canonical = normalizeCode(c.req.query('pairing_code'));
  const codeHash = sha256Hex(canonical);

  // Atomic single-use consumption. Two concurrent polls can't both win.
  const consumed = await db
    .update(deviceLoginCodes)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(deviceLoginCodes.codeHash, codeHash),
        sql`approved_user_id IS NOT NULL`,
        isNull(deviceLoginCodes.consumedAt),
        gt(deviceLoginCodes.expiresAt, sql`now()`),
      ),
    )
    .returning({
      id: deviceLoginCodes.id,
      approvedUserId: deviceLoginCodes.approvedUserId,
      deviceLabel: deviceLoginCodes.deviceLabel,
      devicePlatform: deviceLoginCodes.devicePlatform,
      machineId: deviceLoginCodes.machineId,
    });

  if (consumed.length === 1) {
    const row = consumed[0]!;
    if (!row.approvedUserId) {
      throw new HTTPException(500, {
        message: 'pairing missing user',
        cause: { code: 'PAIRING_NO_USER' },
      });
    }
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, row.approvedUserId))
      .limit(1);
    if (!user) {
      throw new HTTPException(500, {
        message: 'pairing user no longer exists',
        cause: { code: 'PAIRING_USER_MISSING' },
      });
    }

    // Mint a DEVICE token (not a user JWT). Dedupes by machine id when the CLI
    // sent one (re-login from the same machine rotates the token in place,
    // keeping runner bindings); falls back to always-insert otherwise.
    const { device, plaintext } = await issueOrRotateDeviceTokenByMachine({
      ownerId: user.id,
      name: row.deviceLabel,
      platform: row.devicePlatform as LoginPlatform,
      machineId: row.machineId,
    });

    // Optional, flag-gated, best-effort git push-credential provisioning.
    let gitCredential: Awaited<ReturnType<typeof provisionGitCredential>> = null;
    try {
      gitCredential = await provisionGitCredential(device.id);
    } catch (err) {
      logger.error(
        { err, deviceId: device.id },
        'device login: git-cred provisioning failed (login still succeeds)',
      );
      Sentry.captureException(err, {
        level: 'error',
        tags: { area: 'runner-login', phase: 'git-cred-provision' },
        extra: { deviceId: device.id },
      });
    }

    logger.info(
      { approvedUserId: user.id, loginCodeId: row.id, deviceId: device.id },
      'device login: consumed',
    );
    // Refresh the owner's device list on the web Runners surface.
    await publishLoginEvent(user.id, 'device.paired', { deviceId: device.id });

    return c.json({
      device_token: plaintext,
      device_id: device.id,
      ...(gitCredential ? { git_credential: gitCredential } : {}),
    });
  }

  // No row consumed — disambiguate so the CLI shows the right message.
  const [existing] = await db
    .select({
      approvedUserId: deviceLoginCodes.approvedUserId,
      consumedAt: deviceLoginCodes.consumedAt,
      expiresAt: deviceLoginCodes.expiresAt,
    })
    .from(deviceLoginCodes)
    .where(eq(deviceLoginCodes.codeHash, codeHash))
    .limit(1);

  if (!existing) {
    throw new HTTPException(410, {
      message: 'pairing code not found',
      cause: { code: 'PAIRING_CODE_GONE' },
    });
  }
  const expiresAt =
    existing.expiresAt instanceof Date ? existing.expiresAt : new Date(existing.expiresAt);
  if (existing.consumedAt) {
    throw new HTTPException(410, {
      message: 'pairing code already consumed',
      cause: { code: 'PAIRING_CODE_CONSUMED' },
    });
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw new HTTPException(410, {
      message: 'pairing code expired',
      cause: { code: 'PAIRING_CODE_EXPIRED' },
    });
  }
  // Pending — the CLI keeps polling.
  return c.body(null, 204);
});
