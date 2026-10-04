/**
 * ISS-305 — Runner browser-approve device login (OAuth device-authorization
 * flow, cf. `claude login`). Mints a PAT for the approving user, or the chosen
 * agent's AAT, bound to the box's `devices` row, and optionally hands the runner
 * a git push credential so it can push with no manual SSH setup.
 *
 *   1. POST /api/devices/login/init    — the CLI mints a short code; backend
 *      hashes + persists it; returns the formatted code + the /pair verify URL.
 *   2. POST /api/devices/login/approve — the browser (cookie-auth) approves a
 *      typed/linked code, binding it to the signed-in user.
 *   3. GET  /api/devices/login/poll    — the CLI polls every 2 s; 204 while
 *      pending, 200 + {device_token, …} when approved (single-use), 410 when
 *      expired or already consumed. The `device_token` field name is the wire
 *      contract three `forge-runner` versions read; only its species changed.
 *
 * Codes are 7 Crockford base32 chars displayed as `XXX-XXXX`. Server stores
 * only sha256(canonical). 10-minute TTL. Live pending→approved is broadcast on
 * the owner's user room so the web Runners surface updates without polling.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { provisionGitCredential } from '../git/provision-credential.js';
import { logger } from '../logger.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { assertMayMintFullCredential, mintEpochFor } from '../middleware/pat-rest-surface.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { reportFailure } from '../observability/sentry.js';
import { issueDeviceCredential } from './credential.js';
import { loginCodeState, userExists, userKindAndOrg } from './read.js';
import { registerDevice } from './register.js';
import { approveLoginCode, consumeLoginCode, insertLoginCode } from './service.js';
import { requireOrgCan } from '../permissions/index.js';

type LoginPlatform = 'windows' | 'macos' | 'linux';

export const deviceLoginRoutes = new Hono<{ Variables: AuthVars }>();

// Crockford base32 with the easy-to-confuse glyphs removed.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 7;
const LOGIN_TTL_SECONDS = 10 * 60;
const VALID_PLATFORMS: ReadonlySet<string> = new Set(['windows', 'macos', 'linux']);
const MAX_LABEL_LEN = 100;
const MAX_HOSTNAME_LEN = 100;
const MAX_USER_AGENT_LEN = 200;
const MAX_INSERT_RETRIES = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Crockford-base32 7-char code, rejection-sampled so each glyph is uniform over
 * the 32-symbol alphabet (`b & 0x1f` over 0..255 is exact: 256 % 32 == 0).
 */
function generateCanonical(): string {
  const out: string[] = [];
  while (out.length < CODE_LEN) {
    for (const b of randomBytes(CODE_LEN * 2)) {
      if (out.length >= CODE_LEN) break;
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

const initBody = z.object({
  device_label: z.string({ error: 'device_label is required (1..100 chars)' }),
  device_platform: z.string({ error: 'device_platform must be one of windows|macos|linux' }),
  device_hostname: z.string({ error: 'device_hostname must be a string' }).nullable().optional(),
  machine_id: z.string({ error: 'machine_id must be a string' }).nullable().optional(),
});

const approveBody = z.object({
  pairing_code: z.string({ error: 'invalid pairing_code' }),
  agent_id: z.string({ error: 'agent_id must be a uuid' }).nullable().optional(),
});

const pollQuery = z.object({ pairing_code: z.string({ error: 'invalid pairing_code' }) });

type Parsed = { success: true } | { success: false; error: z.core.$ZodError };

const refuseLoginInput = (result: Parsed) => {
  if (result.success) return;
  const first = result.error.issues[0];
  const pairing = first?.path[0] === 'pairing_code';
  throw new HTTPException(400, {
    message: first?.message ?? 'invalid body',
    cause: { code: pairing ? 'INVALID_PAIRING_CODE' : 'INVALID_BODY' },
  });
};

deviceLoginRoutes.post(
  '/login/init',
  rateLimit(() => RULES.deviceLoginInit, { name: 'deviceLoginInit' }),
  zValidator('json', initBody, refuseLoginInput),
  async (c) => {
    const body = c.req.valid('json');

    const deviceLabel = body.device_label.trim();
    const devicePlatform = body.device_platform.trim().toLowerCase();
    const deviceHostnameRaw = body.device_hostname?.trim() ?? '';

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
    const machineId = body.machine_id?.trim() ? body.machine_id.trim().slice(0, 256) : null;

    const createdIp = clientIp(c) ?? null;
    const uaRaw = c.req.header('user-agent') ?? '';
    const createdUserAgent = uaRaw ? uaRaw.slice(0, MAX_USER_AGENT_LEN) : null;
    const expiresAt = new Date(Date.now() + LOGIN_TTL_SECONDS * 1000);

    let canonical = '';
    let insertedId: string | null = null;
    for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
      canonical = generateCanonical();
      const codeHash = sha256Hex(canonical);
      insertedId = await insertLoginCode({
        codeHash,
        deviceLabel,
        devicePlatform,
        deviceHostname,
        machineId,
        createdIp,
        createdUserAgent,
        expiresAt,
      });
      if (insertedId !== null) break;
    }
    if (insertedId === null) {
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
    logger.info({ loginCodeId: insertedId, platform: devicePlatform }, 'device login: code issued');

    return c.json({
      pairing_code: formatted,
      verify_url: `/pair?code=${encodeURIComponent(formatted)}`,
      expires_at: expiresAt.toISOString(),
    });
  },
);

/**
 * The agent a browser approval may pair a box as, or `null` when it named none.
 *
 * An agent is offered to whoever approves, so the choice has to be authorized
 * at approval time: only an org admin of the agent's own org may hand a
 * machine that agent's identity.
 */
async function resolveApprovableAgent(raw: unknown, approverId: string): Promise<string | null> {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
    throw new HTTPException(400, {
      message: 'agent_id must be a uuid',
      cause: { code: 'INVALID_BODY' },
    });
  }
  const agent = await userKindAndOrg(raw);
  if (agent?.kind !== 'agent') {
    throw new HTTPException(404, {
      message: 'agent not found',
      cause: { code: 'AGENT_NOT_FOUND' },
    });
  }
  await requireOrgCan({ userId: approverId }, 'org.admin', agent.orgId);
  return agent.id;
}

deviceLoginRoutes.post(
  '/login/approve',
  rateLimit(() => RULES.deviceLoginApprove, { name: 'deviceLoginApprove' }),
  requireAuth(),
  async (c, next) => {
    assertMayMintFullCredential(c);
    await next();
  },
  zValidator('json', approveBody, refuseLoginInput),
  async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    const canonical = normalizeCode(body.pairing_code);
    const codeHash = sha256Hex(canonical);
    const agentUserId = await resolveApprovableAgent(body.agent_id, userId);

    const row = await approveLoginCode(codeHash, {
      userId,
      agentUserId,
      grantEpoch: mintEpochFor(c),
    });

    if (!row) {
      // Single error shape across "unknown" / "already approved" / "expired"
      // so we don't leak a brute-force oracle.
      throw new HTTPException(404, {
        message: 'pairing code not found',
        cause: { code: 'PAIRING_CODE_NOT_FOUND' },
      });
    }

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

deviceLoginRoutes.get(
  '/login/poll',
  zValidator('query', pollQuery, refuseLoginInput),
  async (c) => {
    const canonical = normalizeCode(c.req.valid('query').pairing_code);
    const codeHash = sha256Hex(canonical);

    // Atomic single-use consumption. Two concurrent polls can't both win.
    const row = await consumeLoginCode(codeHash);
    if (row) {
      if (!row.approvedUserId) {
        throw new HTTPException(500, {
          message: 'pairing missing user',
          cause: { code: 'PAIRING_NO_USER' },
        });
      }
      if (!(await userExists(row.approvedUserId))) {
        throw new HTTPException(500, {
          message: 'pairing user no longer exists',
          cause: { code: 'PAIRING_USER_MISSING' },
        });
      }

      const approvedUserId = row.approvedUserId;
      const holderId = row.agentUserId ?? approvedUserId;
      const device = await registerDevice({
        ownerId: holderId,
        name: row.deviceLabel,
        platform: row.devicePlatform as LoginPlatform,
        machineId: row.machineId,
      });
      const plaintext = await issueDeviceCredential({
        deviceId: device.id,
        holderUserId: holderId,
        holderIsAgent: row.agentUserId != null,
        grantEpoch: row.grantEpoch,
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
        reportFailure(err, {
          level: 'error',
          tags: { area: 'runner-login', phase: 'git-cred-provision' },
          extra: { deviceId: device.id },
        });
      }

      logger.info(
        { approvedUserId, loginCodeId: row.id, deviceId: device.id },
        'device login: consumed',
      );
      // Refresh the owner's device list on the web Runners surface.
      await publishLoginEvent(approvedUserId, 'device.paired', { deviceId: device.id });

      return c.json({
        device_token: plaintext,
        device_id: device.id,
        ...(gitCredential ? { git_credential: gitCredential } : {}),
      });
    }

    // No row consumed — disambiguate so the CLI shows the right message.
    const existing = await loginCodeState(codeHash);

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
  },
);
