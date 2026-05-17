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

const unauth = (message: string) =>
  new HTTPException(401, { message, cause: { code: 'UNAUTHENTICATED' } });

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

export function __resetPatBuckets(): void {
  patBuckets.clear();
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

export const requirePatOrDevice = (): MiddlewareHandler<{ Variables: PrincipalVars }> => {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header) throw unauth('authentication required');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const token = match?.[1]?.trim();
    if (!token) throw unauth('invalid authorization header');

    if (isPatLike(token)) {
      const verified = await verifyPat(token);
      if (!verified) throw unauth('invalid personal access token');
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
    if (!device) throw unauth('invalid device token');
    c.set('principal', { kind: 'device', device });
    await next();
  };
};
