import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import pg from 'pg';
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';
import { env } from '../config/env.js';
import type { RateLimitRule } from '../config/rate-limits.js';
import { RATE_LIMIT_POINTS_TABLE } from '../db/schema-rate-limits.js';
import { logger } from '../observability/logger.js';

let pool: pg.Pool | undefined;

function storePool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 3,
      statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    });
    pool.on('error', (err) => logger.warn({ err }, 'rate-limit: idle store connection lost'));
  }
  return pool;
}

/** One limiter per (max, window) pair; every one writes the same table under the caller's key. */
const limiters = new Map<string, RateLimiterPostgres>();

function limiterFor(max: number, windowMs: number): RateLimiterPostgres {
  const id = `${max}:${windowMs}`;
  let limiter = limiters.get(id);
  if (!limiter) {
    limiter = new RateLimiterPostgres({
      storeClient: storePool(),
      tableName: RATE_LIMIT_POINTS_TABLE,
      tableCreated: true,
      keyPrefix: '',
      points: max,
      duration: windowMs / 1000,
      // Each sweep deletes every expired row of the shared table, so one limiter runs it.
      clearExpiredByTimeout: limiters.size === 0,
    });
    limiters.set(id, limiter);
  }
  return limiter;
}

export interface RateLimitOutcome {
  allowed: boolean;
  max: number;
  windowMs: number;
  remaining: number;
  resetMs: number;
  /** True for the one request that first crossed the ceiling in this window. */
  firstRejectionInWindow: boolean;
}

/**
 * Charge one point to `key` in a fixed window held in Postgres, so the count survives a deploy
 * and expired keys are swept. A store failure is thrown, never read as allowed.
 */
export async function consumeRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<RateLimitOutcome> {
  let res: RateLimiterRes;
  let allowed: boolean;
  try {
    res = await limiterFor(max, windowMs).consume(key);
    allowed = true;
  } catch (rejection) {
    if (!(rejection instanceof RateLimiterRes)) throw rejection;
    res = rejection;
    allowed = false;
  }
  return {
    allowed,
    max,
    windowMs,
    remaining: res.remainingPoints,
    resetMs: Math.max(0, res.msBeforeNext),
    firstRejectionInWindow: !allowed && res.consumedPoints === max + 1,
  };
}

/**
 * Extract client IP. Trusts `x-forwarded-for` (left-most) then `x-real-ip`.
 * NOTE: assumes deployment behind a trusted proxy (Traefik/Coolify). Without
 * one, these headers are client-supplied and spoofable.
 */
export function getClientIp(c: Context): string | undefined {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header('x-real-ip');
  if (real) return real.trim();
  return undefined;
}

function getUserId(c: Context): string | undefined {
  const user = c.get('user' as never) as { id?: string } | undefined;
  if (user?.id) return user.id;
  // `requireAuth` (middleware/auth.ts) sets only `userId`, not `user` —
  // routes behind it (e.g. memory) would otherwise silently key by IP.
  const userId = c.get('userId' as never) as string | undefined;
  return userId;
}

function getPatTokenId(c: Context): string | undefined {
  const tokenId = c.get('patTokenId' as never) as string | undefined;
  return tokenId;
}

function deriveKey(
  rule: RateLimitRule,
  ruleName: string,
  c: Context,
): { key: string; dim: string } | null {
  const ip = getClientIp(c);
  const userId = getUserId(c);

  if (rule.by === 'token') {
    const tokenId = getPatTokenId(c);
    if (tokenId) return { key: `${ruleName}:token:${tokenId}`, dim: 'token' };
    // Fall back to IP so anonymous attackers can't bypass via no-PAT.
    if (ip) return { key: `${ruleName}:ip:${ip}`, dim: 'ip' };
    return null;
  }

  if (rule.by === 'user') {
    if (userId) return { key: `${ruleName}:user:${userId}`, dim: 'user' };
    if (ip) return { key: `${ruleName}:ip:${ip}`, dim: 'ip' };
    return null;
  }

  if (rule.by === 'ip+user') {
    if (userId && ip) return { key: `${ruleName}:ip+user:${ip}|${userId}`, dim: 'ip+user' };
    if (ip) return { key: `${ruleName}:ip:${ip}`, dim: 'ip' };
    if (userId) return { key: `${ruleName}:user:${userId}`, dim: 'user' };
    return null;
  }

  // by === 'ip'
  if (ip) return { key: `${ruleName}:ip:${ip}`, dim: 'ip' };
  return null;
}

export type RateLimitOptions = {
  name?: string;
};

export function rateLimit(
  ruleOf: () => RateLimitRule,
  opts: RateLimitOptions = {},
): MiddlewareHandler {
  const ruleName = opts.name ?? 'default';

  return async (c, next) => {
    const rule = ruleOf();
    const derived = deriveKey(rule, ruleName, c);
    if (!derived) {
      // No identifier available — let the request through rather than share a
      // single global bucket across all anonymous callers.
      await next();
      return;
    }

    const outcome = await consumeRateLimit(derived.key, rule.max, rule.windowMs);
    c.header('X-RateLimit-Limit', String(rule.max));
    c.header('X-RateLimit-Remaining', String(outcome.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil((Date.now() + outcome.resetMs) / 1000)));

    if (!outcome.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(outcome.resetMs / 1000));
      c.header('Retry-After', String(retryAfterSeconds));
      throw new HTTPException(429, {
        message: 'rate limit exceeded',
        cause: { code: 'RATE_LIMITED', details: { retryAfterSeconds } },
      });
    }

    await next();
  };
}
