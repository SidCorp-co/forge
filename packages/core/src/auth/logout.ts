import { Hono } from 'hono';
import { clearSessionCookies } from '../credentials/cookie.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { requiresSelf } from '../permissions/index.js';
import { endSessions } from './service.js';

export const logoutRoutes = new Hono<{ Variables: AuthVars }>();

logoutRoutes.use('/logout', requireAuth());

logoutRoutes.post(
  '/logout',
  requiresSelf('the signed-in caller ends their own sessions'),
  async (c) => {
    const userId = c.get('userId');
    await endSessions(userId);

    clearSessionCookies(c);
    return c.body(null, 204);
  },
);
