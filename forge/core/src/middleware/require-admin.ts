import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { AuthVars } from './auth.js';

function parseAdminList(): string[] {
  const raw = env.ADMIN_EMAILS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Gate a route behind the ADMIN_EMAILS allow-list. Assumes `requireAuth()`
 * + `assertEmailVerified()` already ran upstream. Returns 403 ADMIN_ONLY
 * when the authenticated user's email is not in the list (including the
 * empty-list case when the env var is unset).
 */
export function requireAdmin(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const userId = c.get('userId');
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      throw new HTTPException(401, {
        message: 'user not found',
        cause: { code: 'UNAUTHENTICATED' },
      });
    }
    const allowed = parseAdminList();
    if (!allowed.includes(user.email.toLowerCase())) {
      throw new HTTPException(403, {
        message: 'admin access required',
        cause: { code: 'ADMIN_ONLY' },
      });
    }
    await next();
  };
}
