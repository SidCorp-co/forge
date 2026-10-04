import { Hono } from 'hono';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { clearAuthCookie, clearRefreshCookie } from '../credentials/cookie.js';
import { invalidateRefreshTokens } from './service.js';

export const logoutRoutes = new Hono<{ Variables: AuthVars }>();

logoutRoutes.use('/logout', requireAuth());

logoutRoutes.post('/logout', async (c) => {
  const userId = c.get('userId');
  await invalidateRefreshTokens(userId);

  clearAuthCookie(c);
  clearRefreshCookie(c);
  return c.body(null, 204);
});
