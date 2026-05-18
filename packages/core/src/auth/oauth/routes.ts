import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { oauthAccounts } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { isEnabled } from '../../lib/feature-flags.js';
import { type AuthVars, requireAuth } from '../../middleware/auth.js';
import { handleCallback, handleStart } from './handler.js';
import { getEnabledProviders, toPublic, type ProviderId } from './providers.js';

export const oauthRoutes = new Hono<{ Variables: AuthVars }>();

const VALID_PROVIDERS: ReadonlySet<ProviderId> = new Set(['github', 'google', 'oidc']);

function gate() {
  if (!isEnabled('socialAuth')) {
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
oauthRoutes.get('/oauth/providers', (c) => {
  gate();
  const enabled = getEnabledProviders().map(toPublic);
  return c.json({ providers: enabled });
});

oauthRoutes.get('/oauth/:provider/start', (c) => {
  gate();
  const p = c.req.param('provider');
  if (!VALID_PROVIDERS.has(p as ProviderId)) {
    throw new HTTPException(404, { message: 'unknown provider' });
  }
  return handleStart(c, p as ProviderId);
});

oauthRoutes.get('/oauth/:provider/callback', (c) => {
  gate();
  const p = c.req.param('provider');
  if (!VALID_PROVIDERS.has(p as ProviderId)) {
    throw new HTTPException(404, { message: 'unknown provider' });
  }
  return handleCallback(c, p as ProviderId);
});

// ISS-167 — SSO reauth entry point for password-less users. Verifies the
// caller has a linked row for the requested provider, then runs the standard
// OAuth dance with `mode: 'reauth'` so the callback stamps `lastFreshAuthAt`
// instead of issuing a fresh auth cookie.
oauthRoutes.get('/oauth/:provider/reauth-start', requireAuth(), async (c) => {
  gate();
  const p = c.req.param('provider');
  if (!VALID_PROVIDERS.has(p as ProviderId)) {
    throw new HTTPException(404, { message: 'unknown provider' });
  }
  const providerId = p as ProviderId;
  const uid = c.get('userId');
  const appBase = env.APP_BASE_URL.replace(/\/+$/, '');

  const [linked] = await db
    .select({ id: oauthAccounts.id })
    .from(oauthAccounts)
    .where(
      and(eq(oauthAccounts.userId, uid), eq(oauthAccounts.provider, providerId)),
    )
    .limit(1);

  if (!linked) {
    // Top-level browser navigation, so a JSON 4xx would leave the user on a
    // raw error page. Redirect back to /settings/tokens with a typed code so
    // the page can render a banner.
    return c.redirect(
      `${appBase}/settings/tokens?reauth_error=oauth_not_linked`,
      302,
    );
  }

  return handleStart(c, providerId, { mode: 'reauth', uid });
});
