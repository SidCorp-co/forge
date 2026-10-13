import { Hono } from 'hono';
import { setAuthCookie, setRefreshCookie } from '../credentials/cookie.js';
import { signUserToken } from '../credentials/jwt.js';
import { env } from '../lib/env.js';
import { refuser } from '../lib/refusal.js';
import { DEMO_MEMBER_EMAIL } from './demo-member.js';
import { userByEmail } from './read.js';
import { openRefreshToken } from './service.js';

const refuse = refuser<'DEMO_MODE_OFF' | 'DEMO_MEMBER_MISSING'>('DEMO_MODE_OFF');

export const demoRoutes = new Hono();

/**
 * Signs the demo member in with no credential and sends the browser to the app (REQ-39: Forge
 * previewing itself on demo data). It exists only while the process is a demo core
 * (FORGE_DEMO_MODE=1, which a deployed NODE_ENV refuses at boot); anywhere else it answers
 * DEMO_MODE_OFF and sets nothing. A demo core also signs in every request that carries no
 * credential (web-host/demo-credential.ts), so a browser needs no call here to be signed in.
 */
demoRoutes.get('/demo', async (c) => {
  if (!env.FORGE_DEMO_MODE) {
    throw refuse(
      'DEMO_MODE_OFF',
      'this core is not in demo mode (FORGE_DEMO_MODE=1), so there is no demo session',
    );
  }
  const member = await userByEmail(DEMO_MEMBER_EMAIL);
  if (!member) {
    throw refuse(
      'DEMO_MEMBER_MISSING',
      `demo mode is on but ${DEMO_MEMBER_EMAIL} was never seeded; run the demo seed (tests/helpers/demo-world.ts) before serving`,
    );
  }
  setAuthCookie(c, await signUserToken(member.id));
  const { raw } = await openRefreshToken(member.id);
  setRefreshCookie(c, raw);
  c.header('Cache-Control', 'no-store');
  return c.redirect('/', 302);
});
