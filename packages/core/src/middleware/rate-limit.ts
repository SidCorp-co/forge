import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { RateLimitRule } from '../config/rate-limits.js';

type Bucket = { count: number; resetAt: number };

const store = new Map<string, Bucket>();

/**
 * Internal test hook — clears the in-memory rate-limit store.
 * Call from `beforeEach` in tests to isolate suites.
 */
export function __resetRateLimitStore(): void {
  store.clear();
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
  /** Logical rule name; also used to namespace bucket keys. */
  name?: string;
};

export function rateLimit(rule: RateLimitRule, opts: RateLimitOptions = {}): MiddlewareHandler {
  const ruleName = opts.name ?? 'default';

  return async (c, next) => {
    const derived = deriveKey(rule, ruleName, c);
    if (!derived) {
      // No identifier available — let the request through rather than share a
      // single global bucket across all anonymous callers.
      await next();
      return;
    }

    const now = Date.now();
    let bucket = store.get(derived.key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + rule.windowMs };
      store.set(derived.key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, rule.max - bucket.count);
    const resetSec = Math.ceil(bucket.resetAt / 1000);
    c.header('X-RateLimit-Limit', String(rule.max));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(resetSec));

    if (bucket.count > rule.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      c.header('Retry-After', String(retryAfterSeconds));
      throw new HTTPException(429, {
        message: 'rate limit exceeded',
        cause: { code: 'RATE_LIMITED', details: { retryAfterSeconds } },
      });
    }

    await next();
  };
}
