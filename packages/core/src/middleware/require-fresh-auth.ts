import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { AuthVars } from './auth.js';

export function requireFreshAuth(minutes = 5): MiddlewareHandler<{ Variables: AuthVars }> {
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
