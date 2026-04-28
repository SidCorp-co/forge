import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { clearAuthCookie } from './cookie.js';

export const logoutRoutes = new Hono<{ Variables: AuthVars }>();

logoutRoutes.use('/logout', requireAuth());

logoutRoutes.post('/logout', async (c) => {
  const userId = c.get('userId');
  // Burn every still-valid refresh token for this user. Without this, an
  // attacker who already exfiltrated the refresh token (XSS, shared
  // device, leaked browser profile) can keep minting JWTs for the next
  // 30 days regardless of the user clicking "log out". usedAt is the
  // canonical "spent" marker — `refresh.ts` already short-circuits any
  // verify against a row where `usedAt IS NOT NULL`.
  await db
    .update(refreshTokens)
    .set({ usedAt: sql`now()` })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.usedAt)));

  clearAuthCookie(c);
  return c.body(null, 204);
});
