import { Hono } from 'hono';
import { clearAuthCookie, clearRefreshCookie } from '../credentials/cookie.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { endSessions } from './service.js';

export const logoutRoutes = new Hono<{ Variables: AuthVars }>();

logoutRoutes.use('/logout', requireAuth());

logoutRoutes.post('/logout', async (c) => {
  const userId = c.get('userId');
  await endSessions(userId);

  clearAuthCookie(c);
  clearRefreshCookie(c);
  return c.body(null, 204);
});
