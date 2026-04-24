import { Hono } from 'hono';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { clearAuthCookie } from './cookie.js';

export const logoutRoutes = new Hono<{ Variables: AuthVars }>();

logoutRoutes.use('/logout', requireAuth());

logoutRoutes.post('/logout', (c) => {
  clearAuthCookie(c);
  return c.body(null, 204);
});
