/**
 * Desktop sign-in via pairing code (ADR 0019; supersedes ADR 0017 PKCE).
 *
 *   1. POST /api/auth/desktop/pair-init  — desktop mints a short code,
 *                                          backend hashes + persists it,
 *                                          returns the formatted code.
 *   2. POST /api/auth/desktop/approve   — browser (cookie-auth) approves a
 *                                          typed code, binding it to the
 *                                          signed-in user.
 *   3. GET  /api/auth/desktop/poll      — desktop polls every 2 s; 204 while
 *                                          pending, 200 + {token,user} when
 *                                          approved (single-use), 410 when
 *                                          expired or already consumed.
 *
 * Codes are 7 Crockford base32 chars displayed as `XXX-XXXX`. Server stores
 * only sha256(canonical). 10-minute TTL.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { RULES } from '../../config/rate-limits.js';
import { db } from '../../db/client.js';
import { desktopPairingCodes, users } from '../../db/schema.js';
import { isEnabled } from '../../lib/feature-flags.js';
import { logger } from '../../logger.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireAuth, type AuthVars } from '../../middleware/auth.js';
import { signUserToken } from '../jwt.js';

export const pairingRoutes = new Hono<{ Variables: AuthVars }>();

// === Constants ===

// Crockford base32 with the easy-to-confuse glyphs removed.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 7;
const PAIRING_TTL_SECONDS = 10 * 60;
const VALID_PLATFORMS: ReadonlySet<string> = new Set(['windows', 'macos', 'linux']);
const MAX_LABEL_LEN = 100;
const MAX_HOSTNAME_LEN = 100;
const MAX_USER_AGENT_LEN = 200;
const MAX_INSERT_RETRIES = 5;

// === Helpers ===

function gate(): void {
  if (!isEnabled('desktopPairing')) {
    throw new HTTPException(404, {
      message: 'desktop pairing is disabled',
      cause: { code: 'NOT_FOUND' },
    });
  }
}

/**
 * Crockford-base32 7-char code, rejection-sampled so each glyph is uniform
 * over the 32-symbol alphabet (`randomBytes % 32` would skew toward the
 * low 8 symbols because 256 % 32 == 0; cap-and-resample avoids that).
 */
function generateCanonical(): string {
  const out: string[] = [];
  while (out.length < CODE_LEN) {
    const buf = randomBytes(CODE_LEN * 2);
    for (let i = 0; i < buf.length && out.length < CODE_LEN; i++) {
      const b = buf[i]!;
      // Largest multiple of 32 ≤ 256 is 256 itself, so this is exact: 0..255 % 32.
      out.push(CROCKFORD_ALPHABET[b & 0x1f]!);
    }
  }
  return out.join('');
}

function formatCode(canonical: string): string {
  return `${canonical.slice(0, 3)}-${canonical.slice(3)}`;
}

export function normalizeCode(input: unknown): string {
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

// === 1) POST /desktop/pair-init ===

pairingRoutes.post(
  '/desktop/pair-init',
  rateLimit(RULES.desktopPairInit, { name: 'desktopPairInit' }),
  async (c) => {
    gate();

    let body: {
      device_label?: unknown;
      device_platform?: unknown;
      device_hostname?: unknown;
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

    const createdIp = clientIp(c) ?? null;
    const uaRaw = c.req.header('user-agent') ?? '';
    const createdUserAgent = uaRaw ? uaRaw.slice(0, MAX_USER_AGENT_LEN) : null;
    const expiresAt = new Date(Date.now() + PAIRING_TTL_SECONDS * 1000);

    // Birthday collisions in 32^7 are negligible but the UNIQUE constraint
    // covers them. onConflictDoNothing returns an empty array; loop a few
    // times before bailing.
    let canonical = '';
    let inserted: { id: string }[] = [];
    for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
      canonical = generateCanonical();
      const codeHash = sha256Hex(canonical);
      inserted = await db
        .insert(desktopPairingCodes)
        .values({
          codeHash,
          deviceLabel,
          devicePlatform,
          deviceHostname,
          createdIp,
          createdUserAgent,
          expiresAt,
        })
        .onConflictDoNothing({ target: desktopPairingCodes.codeHash })
        .returning({ id: desktopPairingCodes.id });
      if (inserted.length > 0) break;
    }
    if (inserted.length === 0) {
      logger.error(
        { retries: MAX_INSERT_RETRIES },
        'desktop pairing: code generation collided every attempt',
      );
      throw new HTTPException(500, {
        message: 'could not allocate pairing code',
        cause: { code: 'CODE_GENERATION_FAILED' },
      });
    }

    logger.info(
      { pairingCodeId: inserted[0]!.id, platform: devicePlatform },
      'desktop pairing: code issued',
    );

    return c.json({
      pairing_code: formatCode(canonical),
      expires_at: expiresAt.toISOString(),
    });
  },
);

// === 2) POST /desktop/approve ===

pairingRoutes.post(
  '/desktop/approve',
  rateLimit(RULES.desktopApprove, { name: 'desktopApprove' }),
  requireAuth(),
  async (c) => {
    gate();
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
      .update(desktopPairingCodes)
      .set({ approvedUserId: userId, approvedAt: sql`now()` })
      .where(
        and(
          eq(desktopPairingCodes.codeHash, codeHash),
          isNull(desktopPairingCodes.approvedUserId),
          isNull(desktopPairingCodes.consumedAt),
          gt(desktopPairingCodes.expiresAt, sql`now()`),
        ),
      )
      .returning({
        id: desktopPairingCodes.id,
        deviceLabel: desktopPairingCodes.deviceLabel,
        devicePlatform: desktopPairingCodes.devicePlatform,
        deviceHostname: desktopPairingCodes.deviceHostname,
        createdIp: desktopPairingCodes.createdIp,
        createdUserAgent: desktopPairingCodes.createdUserAgent,
        createdAt: desktopPairingCodes.createdAt,
        expiresAt: desktopPairingCodes.expiresAt,
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

    logger.info(
      { approvedUserId: userId, pairingCodeId: row.id },
      'desktop pairing: approved',
    );

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

// === 3) GET /desktop/poll ===

pairingRoutes.get('/desktop/poll', async (c) => {
  gate();
  const canonical = normalizeCode(c.req.query('pairing_code'));
  const codeHash = sha256Hex(canonical);

  // Atomic single-use consumption. Two concurrent polls can't both win.
  const consumed = await db
    .update(desktopPairingCodes)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(desktopPairingCodes.codeHash, codeHash),
        // SQL-level "is not null" via raw NOT NULL check; drizzle's isNotNull
        // import would be needed otherwise.
        sql`approved_user_id IS NOT NULL`,
        isNull(desktopPairingCodes.consumedAt),
        gt(desktopPairingCodes.expiresAt, sql`now()`),
      ),
    )
    .returning({
      id: desktopPairingCodes.id,
      approvedUserId: desktopPairingCodes.approvedUserId,
    });

  if (consumed.length === 1) {
    const row = consumed[0]!;
    if (!row.approvedUserId) {
      // Invariant violation: approved_user_id was non-null in the WHERE but
      // came back null. Defensive.
      throw new HTTPException(500, {
        message: 'pairing missing user',
        cause: { code: 'PAIRING_NO_USER' },
      });
    }
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, row.approvedUserId))
      .limit(1);
    if (!user) {
      throw new HTTPException(500, {
        message: 'pairing user no longer exists',
        cause: { code: 'PAIRING_USER_MISSING' },
      });
    }
    const token = await signUserToken(user.id);
    logger.info(
      { approvedUserId: user.id, pairingCodeId: row.id },
      'desktop pairing: consumed',
    );
    return c.json({ token, user });
  }

  // No row consumed — disambiguate so the desktop UI shows the right message.
  const [existing] = await db
    .select({
      approvedUserId: desktopPairingCodes.approvedUserId,
      consumedAt: desktopPairingCodes.consumedAt,
      expiresAt: desktopPairingCodes.expiresAt,
    })
    .from(desktopPairingCodes)
    .where(eq(desktopPairingCodes.codeHash, codeHash))
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
  // Pending — desktop keeps polling.
  return c.body(null, 204);
});
