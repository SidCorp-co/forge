import { demoMemberId } from '../auth/index.js';
import { AUTH_COOKIE_NAME, cookieValues } from '../credentials/cookie.js';
import { signUserToken, USER_JWT_TTL_SECONDS } from '../credentials/jwt.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

type Fetch = (request: Request, ...rest: never[]) => Response | Promise<Response>;

/** A credential this close to its end is signed again, so a request never carries a dead one. */
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

/**
 * Forge previewing itself on demo data (`pnpm preview:demo`, REQ-39 / REQ-41 BC-14, BC-21): a demo
 * core answers every request that carries no credential as its seeded member, so the browser holds
 * no cookie at all and a frame on another site (Safari blocks every third-party cookie, Chrome
 * never sends SameSite=Lax into one) is signed in exactly like a tab. Anywhere that is not a demo
 * core a request passes to `fetch` as it came; the socket's door is attachWs's `credentialless`.
 */
export function withDemoCredential<F extends Fetch>(fetch: F): F {
  let held: { token: string; renewAt: number } | null = null;
  let warned = false;

  const credential = async (): Promise<string | null> => {
    if (held && Date.now() < held.renewAt) return held.token;
    const member = await demoMemberId();
    if (!member) {
      if (!warned) {
        warned = true;
        logger.error(
          'demo mode is on but the demo member was never seeded; run the demo seed (tests/helpers/demo-world.ts): requests are served signed out',
        );
      }
      return null;
    }
    const token = await signUserToken(member);
    held = { token, renewAt: Date.now() + USER_JWT_TTL_SECONDS * 1000 - RENEW_BEFORE_MS };
    return token;
  };

  return (async (request: Request, ...rest: never[]) => {
    // read per request, never at wrap time: the wrap happens as core is imported
    if (!env.FORGE_DEMO_MODE) return fetch(request, ...rest);
    const signed =
      request.headers.has('authorization') ||
      cookieValues(request.headers.get('cookie'), AUTH_COOKIE_NAME).length > 0;
    const token = signed ? null : await credential();
    if (!token) return fetch(request, ...rest);
    const headers = new Headers(request.headers);
    const cookie = request.headers.get('cookie');
    headers.set('cookie', `${cookie ? `${cookie}; ` : ''}${AUTH_COOKIE_NAME}=${token}`);
    return fetch(new Request(request, { headers }), ...rest);
  }) as F;
}
