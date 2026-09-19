import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { writeMcpAudit } from '../auth/mcp-audit.js';
import { touchPatUsage, verifyPat } from '../auth/pat.js';
import { isPatLike } from '../auth/pat-format.js';
import { type PatRequestClass, patRuleFor } from '../config/rate-limits.js';
import { userRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { parseBearerHeader } from './bearer.js';
import { getClientIp } from './rate-limit.js';

export type PatPrincipal = {
  kind: 'pat';
  agency: 'agent' | null;
  agentUserId: string | null;
  userId: string;
  tokenId: string;
  scopes: readonly string[];
  projectIds: readonly string[] | null;
  boundProjectId: string | null;
  /**
   * The permission names this token was granted, or absent where it was
   * granted none — which is every group, not no group.
   */
  permissions?: readonly string[] | null;
  /**
   * The paired box this token was issued to, or `null` for a token a person
   * holds. It is what `requireDevice` and `/ws` resolve a device from now that
   * a device is a registry row rather than a credential (ISS-932).
   */
  deviceId: string | null;
};

export type McpPrincipal = PatPrincipal;

export type PrincipalVars = {
  principal: McpPrincipal;
  patTokenId?: string;
  patRequestClass?: PatRequestClass;
};

const unauth = (message: string, options?: { invalidToken?: boolean; invalidRequest?: boolean }) =>
  new HTTPException(401, {
    message,
    cause: {
      code: 'UNAUTHENTICATED',
      wwwAuthenticate: options?.invalidToken
        ? 'Bearer realm="forge-mcp", error="invalid_token"'
        : options?.invalidRequest
          ? 'Bearer realm="forge-mcp", error="invalid_request"'
          : 'Bearer realm="forge-mcp"',
    },
  });

type PatBucket = {
  minuteCount: number;
  minuteResetAt: number;
};
const patBuckets = new Map<string, PatBucket>();

const bucketKey = (tokenId: string, requestClass: PatRequestClass) => `${tokenId}:${requestClass}`;

/**
 * Throttle map for `pat.used` WS events. The dispatcher fires once per
 * successful PAT request, but high-frequency MCP clients can hammer at many
 * Hz — without throttling we'd flood the user's WS connection. Emit at most
 * once per token per minute; the audit log remains the source of truth for
 * fine-grained per-request history.
 */
const patUsedLastEmit = new Map<string, number>();
const PAT_USED_THROTTLE_MS = 60 * 1000;

export function __resetPatBuckets(): void {
  patBuckets.clear();
  patUsedLastEmit.clear();
}

/**
 * Drop in-process throttle state for a token id. Called from PAT revoke /
 * rotate paths so the map stays bounded by active-PAT count rather than
 * lifetime-PAT count (the entry would otherwise live for the process
 * lifetime even after the token is unusable).
 */
export function forgetPatThrottle(tokenId: string): void {
  patUsedLastEmit.delete(tokenId);
  patBuckets.delete(bucketKey(tokenId, 'read'));
  patBuckets.delete(bucketKey(tokenId, 'write'));
}

interface RateLimitOutcome {
  allowed: boolean;
  max: number;
  windowMs: number;
  remaining: number;
  resetMs: number;
  firstRejectionInWindow: boolean;
}

function checkPatRateLimit(
  tokenId: string,
  requestClass: PatRequestClass,
  maxOverride: number | null,
): RateLimitOutcome {
  const rule = patRuleFor(requestClass);
  const max = maxOverride ?? rule.max;
  const windowMs = rule.windowMs;

  const key = bucketKey(tokenId, requestClass);
  const now = Date.now();
  let bucket = patBuckets.get(key);
  if (!bucket || now >= bucket.minuteResetAt) {
    bucket = { minuteCount: 0, minuteResetAt: now + windowMs };
    patBuckets.set(key, bucket);
  }

  bucket.minuteCount += 1;
  const base = { max, windowMs, resetMs: bucket.minuteResetAt - now };
  if (bucket.minuteCount > max) {
    return {
      ...base,
      allowed: false,
      remaining: 0,
      firstRejectionInWindow: bucket.minuteCount === max + 1,
    };
  }
  return {
    ...base,
    allowed: true,
    remaining: Math.max(0, max - bucket.minuteCount),
    firstRejectionInWindow: false,
  };
}

function maybeEmitPatUsed(tokenId: string, userId: string): void {
  const now = Date.now();
  const last = patUsedLastEmit.get(tokenId);
  if (last && now - last < PAT_USED_THROTTLE_MS) return;
  patUsedLastEmit.set(tokenId, now);
  roomManager.publish(userRoom(userId), {
    event: 'pat.used',
    data: { tokenId, userId, ts: new Date(now).toISOString() },
  });
}

/**
 * Verify a `forge_pat_*` token and charge it against its rate limit, or
 * return null when the token does not resolve. Throws 429 when the token is
 * over its ceiling.
 *
 * Shared with `requireAuth()` in `middleware/auth.ts`, which authenticates the
 * same tokens on the REST data plane. Extracted rather than copied so every
 * surface that accepts a PAT charges the SAME pair of buckets: the ceiling a
 * token owner reads in `X-RateLimit-Limit` is one number per class, not one
 * per surface.
 *
 * `requestClass` is which of the two budgets this request spends, decided by
 * the caller because only it knows: REST reads it off the HTTP method
 * (`pat-rest-surface.ts:scopeForMethod`), `/mcp` off the JSON-RPC envelope
 * (`mcp/request-class.ts`).
 */
export async function authenticatePat(
  c: Context,
  token: string,
  requestClass: PatRequestClass,
  onVerified?: () => void,
): Promise<PatPrincipal | null> {
  const verified = await verifyPat(token);
  if (!verified) return null;
  onVerified?.();
  const { row, ownerKind } = verified;

  const outcome = checkPatRateLimit(row.id, requestClass, row.rateLimitMax);
  c.header('X-RateLimit-Limit', String(outcome.max));
  c.header('X-RateLimit-Remaining', String(outcome.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil((Date.now() + outcome.resetMs) / 1000)));
  c.header('X-RateLimit-Scope', requestClass);
  if (!outcome.allowed) {
    if (outcome.firstRejectionInWindow) {
      writeMcpAudit({
        userId: row.userId,
        tokenId: row.id,
        deviceId: null,
        tool: 'rate_limit',
        action: `${c.req.method} ${c.req.path}`,
        resultCode: 'rate_limited',
        ip: getClientIp(c) ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      });
    }
    const retryAfterSeconds = Math.max(1, Math.ceil(outcome.resetMs / 1000));
    const windowSeconds = Math.ceil(outcome.windowMs / 1000);
    c.header('Retry-After', String(retryAfterSeconds));
    throw new HTTPException(429, {
      message:
        `rate limit exceeded: ${outcome.max} ${requestClass} request(s) per ` +
        `${windowSeconds}s on this token — retry after ${retryAfterSeconds}s`,
      cause: {
        code: 'RATE_LIMITED',
        details: {
          retryAfterSeconds,
          windowSeconds,
          limit: outcome.max,
          remaining: outcome.remaining,
          scope: requestClass,
        },
      },
    });
  }

  touchPatUsage(row.id, getClientIp(c));
  maybeEmitPatUsed(row.id, row.userId);
  return {
    kind: 'pat',
    agency: ownerKind === 'agent' ? 'agent' : null,
    agentUserId: ownerKind === 'agent' ? row.userId : null,
    userId: row.userId,
    tokenId: row.id,
    scopes: row.scopes,
    projectIds: row.projectIds ?? null,
    permissions: row.permissions ?? null,
    boundProjectId: row.boundProjectId ?? null,
    deviceId: row.deviceId ?? null,
  };
}

const DEVICE_TOKEN_REFUSAL =
  'device tokens no longer authenticate /mcp — an agent session presents its own ' +
  '`job:`/`session:` token, minted by core and written into the job MCP config by ' +
  'forge-runner. A runner box seeing this needs a newer forge-runner binary; the device ' +
  'token still authenticates /ws and the device REST routes.';

export const requirePat = (): MiddlewareHandler<{ Variables: PrincipalVars }> => {
  return async (c, next) => {
    const parsed = parseBearerHeader(c);
    if (parsed.kind === 'absent') throw unauth('authentication required');
    if (parsed.kind === 'malformed')
      throw unauth('invalid authorization header', { invalidRequest: true });
    const token = parsed.token;

    if (!isPatLike(token)) throw unauth(DEVICE_TOKEN_REFUSAL, { invalidToken: true });

    const principal = await authenticatePat(c, token, c.get('patRequestClass') ?? 'write');
    if (!principal) throw unauth('invalid personal access token', { invalidToken: true });
    c.set('patTokenId', principal.tokenId);
    c.set('principal', principal);
    await next();
  };
};
