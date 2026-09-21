import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { clearAuthCookie, clearRefreshCookie } from './cookie.js';

export const logoutRoutes = new Hono<{ Variables: AuthVars }>();

logoutRoutes.use('/logout', requireAuth());

logoutRoutes.post('/logout', async (c) => {
  const userId = c.get('userId');
  await db
    .update(refreshTokens)
    .set({ usedAt: sql`now()` })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.usedAt)));

  clearAuthCookie(c);
  clearRefreshCookie(c);
  return c.body(null, 204);
});
