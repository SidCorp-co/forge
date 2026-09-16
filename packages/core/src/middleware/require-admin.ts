import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env.js';
import { type AuthVars, authUserRow, readAuthUser } from './auth.js';

export function parseAdminList(): string[] {
  const raw = env.ADMIN_EMAILS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Whether this address is on the allow-list, as every reader of it asks. */
export function onAdminList(email: string): boolean {
  return parseAdminList().includes(email.toLowerCase());
}

/**
 * The allow-list read, as an answer rather than a throw, for a caller with no
 * HTTP response to throw into — the WS `canSubscribe` gate.
 *
 * A user id that resolves to no row answers `false`: outside a request there
 * is no session to invalidate, and "not an admin" is the safe reading.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const row = await readAuthUser(userId);
  return row !== null && onAdminList(row.email);
}

/**
 * Throws 401/403 unless the request's `userId` is on the ADMIN_EMAILS
 * allow-list. The standalone check behind {@link requireAdmin}, also usable
 * inline inside a handler that only needs the admin gate on one branch (e.g. a
 * query-param dependent view) rather than the whole route.
 */
export async function assertPlatformAdmin(c: Context<{ Variables: AuthVars }>): Promise<void> {
  const row = await authUserRow(c, c.get('userId'));
  if (row === null) {
    throw new HTTPException(401, {
      message: 'user not found',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }
  if (!onAdminList(row.email)) {
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
    await assertPlatformAdmin(c);
    await next();
  };
}
