import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ProviderId } from '../../integrations/identity/index.js';
import { env } from '../../lib/env.js';
import { type AuthVars, requireAuth } from '../../middleware/auth.js';
import { noQuery, zValidator } from '../../middleware/zod-validator.js';
import { requiresPublic, requiresSelf } from '../../permissions/index.js';
import { hasOauthLink } from '../read.js';
import {
  callbackQuery,
  handleCallback,
  handleStart,
  refuseCallbackQuery,
  refuseStartQuery,
  startQuery,
} from './handler.js';
import { getEnabledProviders, toPublic } from './providers.js';

/** `FEATURE_SOCIAL_AUTH` unset means on; set, only `true` or `1` keeps it on. */
function socialAuthEnabled(): boolean {
  const v = process.env.FEATURE_SOCIAL_AUTH;
  return v === undefined || v === 'true' || v === '1';
}

export const oauthRoutes = new Hono<{ Variables: AuthVars }>();

const VALID_PROVIDERS: ReadonlySet<ProviderId> = new Set(['github', 'google', 'oidc']);

function gate() {
  if (!socialAuthEnabled()) {
    throw new HTTPException(404, {
      message: 'social auth is disabled',
      cause: { code: 'NOT_FOUND' },
    });
  }
}

/**
 * Lists the providers whose env vars are populated. Frontend renders one
 * button per row. The flag also gates this — when off, the endpoint 404s
 * so a probe can't enumerate which providers are configured.
 */
oauthRoutes.get(
  '/oauth/providers',
  requiresPublic('the sign-in page lists the enabled providers before anyone is signed in'),
  noQuery,
  (c) => {
    gate();
    const enabled = getEnabledProviders().map(toPublic);
    return c.json({ providers: enabled });
  },
);

const knownProvider: MiddlewareHandler = async (c, next) => {
  gate();
  if (!VALID_PROVIDERS.has(c.req.param('provider') as ProviderId)) {
    throw new HTTPException(404, { message: 'unknown provider' });
  }
  await next();
};

oauthRoutes.get(
  '/oauth/:provider/start',
  requiresPublic(
    'a caller with no session starts a provider sign-in; the provider’s answer is the credential',
  ),
  knownProvider,
  zValidator('query', startQuery, refuseStartQuery),
  (c) => handleStart(c, c.req.param('provider') as ProviderId, c.req.valid('query')),
);

oauthRoutes.get(
  '/oauth/:provider/callback',
  requiresPublic(
    'the provider sends the browser back with its code and the state this core issued, which are the key',
  ),
  knownProvider,
  zValidator('query', callbackQuery, refuseCallbackQuery),
  (c) => handleCallback(c, c.req.param('provider') as ProviderId, c.req.valid('query')),
);

oauthRoutes.get(
  '/oauth/:provider/reauth-start',
  requireAuth(),
  requiresSelf('the signed-in caller proves their own provider link again'),
  knownProvider,
  zValidator('query', startQuery, refuseStartQuery),
  async (c) => {
    const providerId = c.req.param('provider') as ProviderId;
    const uid = c.get('userId');
    const appBase = env.APP_BASE_URL.replace(/\/+$/, '');

    if (!(await hasOauthLink(uid, providerId))) {
      // Top-level browser navigation, so a JSON 4xx would leave the user on a
      // raw error page. Redirect back to the tokens settings tab with a typed
      // code so the page can render a banner.
      return c.redirect(`${appBase}/settings?tab=tokens&reauth_error=oauth_not_linked`, 302);
    }

    return handleStart(c, providerId, c.req.valid('query'), { mode: 'reauth', uid });
  },
);
