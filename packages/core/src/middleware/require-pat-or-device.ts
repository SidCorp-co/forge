/**
 * Dispatcher middleware (ISS-150).
 *
 * Accepts `Authorization: Bearer <token>` for either a Personal Access
 * Token (`forge_pat_*`) or a legacy device token. Sets `c.get('principal')`
 * to the resolved {@link McpPrincipal} union for downstream tool handlers,
 * and sets `c.get('patTokenId')` when the principal is a PAT so the
 * generic rate-limit middleware (`by: 'token'`) can key off it.
 *
 * On PAT path the dispatcher also:
 *   - enforces a per-token rolling rate limit (RULES.patPerToken) honoring
 *     `personal_access_tokens.rate_limit_max` overrides
 *   - auto-revokes a PAT that has hit the rate-limit ceiling three times
 *     within an hour
 *   - records last-used timestamp + IP asynchronously
 */

import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type Device, verifyDeviceToken } from '../auth/deviceToken.js';
import { isPatLike } from '../auth/pat-format.js';
import { forceRevokePat, touchPatUsage, verifyPat } from '../auth/pat.js';
import { RULES } from '../config/rate-limits.js';
import { userRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { getClientIp } from './rate-limit.js';

export type PatPrincipal = {
  kind: 'pat';
  userId: string;
  tokenId: string;
  scopes: readonly string[];
  projectIds: readonly string[] | null;
};

export type DevicePrincipal = { kind: 'device'; device: Device };

export type McpPrincipal = PatPrincipal | DevicePrincipal;

export type PrincipalVars = {
  principal: McpPrincipal;
  patTokenId?: string;
};

/**
 * Build a 401 that includes a Bearer-only WWW-Authenticate challenge. The
 * header tells RFC 6750 / MCP clients "this is bearer-token-only, don't
 * try OAuth Dynamic Client Registration" — without it, Claude Code's MCP
 * HTTP transport silently falls back to POST /register on any 401 and the
 * resulting 404 surfaces as a misleading "Invalid OAuth error response:
 * ZodError" instead of the real auth failure. The error.ts handler reads
 * `cause.wwwAuthenticate` and attaches the header before responding.
 */
const unauth = (message: string, options?: { invalidToken?: boolean }) =>
  new HTTPException(401, {
    message,
    cause: {
      code: 'UNAUTHENTICATED',
      wwwAuthenticate: options?.invalidToken
        ? 'Bearer realm="forge-mcp", error="invalid_token"'
        : 'Bearer realm="forge-mcp"',
    },
  });

/**
 * Two-dimensional rate-limit bucket for PAT use:
 *   - per-minute count for the 429 trigger
 *   - per-hour count of how many minute-windows have been breached;
 *     when this hits 3 the PAT is auto-revoked.
 *
 * In-memory by design; survives a single-process restart only, which is
 * acceptable for an alpha-level alerting heuristic (the audit-log table
 * is the source of truth for forensic analysis).
 */
type PatBucket = {
  minuteCount: number;
  minuteResetAt: number;
  hourBreaches: number;
  hourResetAt: number;
};
const patBuckets = new Map<string, PatBucket>();

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
  patBuckets.delete(tokenId);
}

interface RateLimitOutcome {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  breachedThreshold: boolean;
}

function checkPatRateLimit(tokenId: string, maxOverride: number | null): RateLimitOutcome {
  const max = maxOverride ?? RULES.patPerToken.max;
  const windowMs = RULES.patPerToken.windowMs;
  const hourMs = 60 * 60 * 1000;
  const breachLimit = 3;

  const now = Date.now();
  let bucket = patBuckets.get(tokenId);
  if (!bucket || now >= bucket.minuteResetAt) {
    bucket = {
      minuteCount: 0,
      minuteResetAt: now + windowMs,
      hourBreaches: bucket && now < bucket.hourResetAt ? bucket.hourBreaches : 0,
      hourResetAt: bucket && now < bucket.hourResetAt ? bucket.hourResetAt : now + hourMs,
    };
    patBuckets.set(tokenId, bucket);
  }
  if (now >= bucket.hourResetAt) {
    bucket.hourBreaches = 0;
    bucket.hourResetAt = now + hourMs;
  }

  bucket.minuteCount += 1;
  if (bucket.minuteCount > max) {
    if (bucket.minuteCount === max + 1) bucket.hourBreaches += 1;
    return {
      allowed: false,
      remaining: 0,
      resetMs: bucket.minuteResetAt - now,
      breachedThreshold: bucket.hourBreaches >= breachLimit,
    };
  }
  return {
    allowed: true,
    remaining: Math.max(0, max - bucket.minuteCount),
    resetMs: bucket.minuteResetAt - now,
    breachedThreshold: false,
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

export const requirePatOrDevice = (): MiddlewareHandler<{ Variables: PrincipalVars }> => {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header) throw unauth('authentication required');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const token = match?.[1]?.trim();
    if (!token) throw unauth('invalid authorization header');

    if (isPatLike(token)) {
      const verified = await verifyPat(token);
      if (!verified) throw unauth('invalid personal access token', { invalidToken: true });
      const { row } = verified;

      const outcome = checkPatRateLimit(row.id, row.rateLimitMax);
      c.header('X-RateLimit-Limit', String(row.rateLimitMax ?? RULES.patPerToken.max));
      c.header('X-RateLimit-Remaining', String(outcome.remaining));
      if (!outcome.allowed) {
        if (outcome.breachedThreshold) {
          // Sustained abuse — burn the token. Fire-and-forget so the 429 is fast.
          void forceRevokePat(row.id);
        }
        const retryAfterSeconds = Math.max(1, Math.ceil(outcome.resetMs / 1000));
        c.header('Retry-After', String(retryAfterSeconds));
        throw new HTTPException(429, {
          message: 'rate limit exceeded',
          cause: { code: 'RATE_LIMITED', details: { retryAfterSeconds } },
        });
      }

      touchPatUsage(row.id, getClientIp(c));
      maybeEmitPatUsed(row.id, row.userId);
      c.set('patTokenId', row.id);
      c.set('principal', {
        kind: 'pat',
        userId: row.userId,
        tokenId: row.id,
        scopes: row.scopes,
        projectIds: row.projectIds ?? null,
      });
      await next();
      return;
    }

    const device = await verifyDeviceToken(token);
    if (!device) throw unauth('invalid device token', { invalidToken: true });
    c.set('principal', { kind: 'device', device });
    await next();
  };
};
