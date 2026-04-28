import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { isEnabled } from '../../lib/feature-flags.js';
import { handleCallback, handleStart } from './handler.js';
import { getEnabledProviders, toPublic, type ProviderId } from './providers.js';

export const oauthRoutes = new Hono();

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
