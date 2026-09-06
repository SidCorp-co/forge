import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { AuthVars } from './auth.js';

// cm:edge lockstep -> packages/core/src/notifications/platform-admins.ts — platformAdminUserIds resolves the same allow-list against `users` so an ops-alert recipient is exactly someone who can also open the gated GET
export function parseAdminList(): string[] {
  const raw = env.ADMIN_EMAILS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * The allow-list read, as an answer rather than a throw. For a caller with no
 * HTTP response to throw into — the WS `canSubscribe` gate — and as the single
 * lookup {@link assertPlatformAdmin} converts into 401/403.
 *
 * A user id that resolves to no row answers `false`: outside a request there
 * is no session to invalidate, and "not an admin" is the safe reading.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const email = await emailOf(userId);
  return email !== null && parseAdminList().includes(email);
}

/** The one `users` read both gates share, lowercased for the allow-list
 *  compare. `null` means no such row. */
async function emailOf(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ? user.email.toLowerCase() : null;
}

/**
 * Throws 401/403 unless `userId` is on the ADMIN_EMAILS allow-list. The
 * standalone check behind `requireAdmin()`, also usable inline inside a
 * handler that only needs the admin gate on one branch (e.g. a query-param
 * dependent view) rather than the whole route.
 */
export async function assertPlatformAdmin(userId: string): Promise<void> {
  const email = await emailOf(userId);
  if (email === null) {
    throw new HTTPException(401, {
      message: 'user not found',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }
  if (!parseAdminList().includes(email)) {
    throw new HTTPException(403, {
      message: 'admin access required',
      cause: { code: 'ADMIN_ONLY' },
    });
  }
}

/**
 * Gate a route behind the ADMIN_EMAILS allow-list. Assumes `requireAuth()`
 * + `assertEmailVerified()` already ran upstream. Returns 403 ADMIN_ONLY
 * when the authenticated user's email is not in the list (including the
 * empty-list case when the env var is unset).
 */
export function requireAdmin(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    await assertPlatformAdmin(c.get('userId'));
    await next();
  };
}
