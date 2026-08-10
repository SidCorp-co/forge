import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { AuthVars } from './auth.js';

// ISS-158 — Sensitive-surface gate. Sits behind requireAuth() and rejects
// requests whose user has no `last_fresh_auth_at` stamp, or one older than
// `minutes`. Client re-authenticates via POST /api/auth/reauth to refresh
// the stamp, then retries the gated request inside the same window.
//
// Default window is 5 minutes — short enough that a stale tab can't fire
// off destructive calls long after the user walked away, generous enough
// to chain a couple of sensitive actions without prompting twice.
export function requireFreshAuth(
  minutes = 5,
): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const userId = c.get('userId');

    const stale = () =>
      new HTTPException(403, {
        message: 'fresh authentication required',
        cause: { code: 'FRESH_AUTH_REQUIRED' },
      });

    const [row] = await db
      .select({ lastFreshAuthAt: users.lastFreshAuthAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row || !row.lastFreshAuthAt) throw stale();

    const ageMs = Date.now() - row.lastFreshAuthAt.getTime();
    if (ageMs > minutes * 60_000) throw stale();

    await next();
  };
}
