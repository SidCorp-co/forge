/**
 * Fresh-auth gate for sensitive write endpoints (ISS-149 Sub 1 surface,
 * consumed by ISS-160 PAT mint/rotate).
 *
 * A user is "fresh" for `maxMinutes` after a successful password re-verify via
 * `POST /api/auth/reauth`. The stamp is held in-memory per process — survives
 * a single-process restart only, which matches the volatility profile of the
 * PAT rate-limit buckets next door (`require-pat-or-device.ts`).
 *
 * Multi-instance deploys lose freshness on the inactive instance; that fails
 * closed (extra reauth prompt) rather than open (silent bypass), which is the
 * right trade for a defense-in-depth check.
 */

import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthVars } from './auth.js';

const freshAuthStamps = new Map<string, number>();

export function markFreshAuth(userId: string, at: number = Date.now()): void {
  freshAuthStamps.set(userId, at);
}

export function getFreshAuthStamp(userId: string): number | null {
  return freshAuthStamps.get(userId) ?? null;
}

export function __resetFreshAuthStamps(): void {
  freshAuthStamps.clear();
}

export function requireFreshAuth(maxMinutes: number): MiddlewareHandler<{ Variables: AuthVars }> {
  const windowMs = maxMinutes * 60 * 1000;
  return async (c, next) => {
    const userId = c.get('userId');
    const stamp = freshAuthStamps.get(userId);
    const now = Date.now();
    if (!stamp || now - stamp > windowMs) {
      throw new HTTPException(403, {
        message: 'recent re-authentication required',
        cause: { code: 'FRESH_AUTH_REQUIRED', details: { windowMinutes: maxMinutes } },
      });
    }
    await next();
  };
}
