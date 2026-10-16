// CORS for the widget's site-key routes, answered per binding: a page of one of the origins a
// binding allows may call `/api/widget/<site key>/config` and `/sessions` from its own script. The
// global list (`middleware/cors.ts`) is not loosened by a single origin: a request from an origin
// the binding does not name falls through to it, and is answered as it would be anywhere else.
// Registered ahead of the global middleware, because that one answers every preflight itself.

import type { MiddlewareHandler } from 'hono';
import { activeWidgetBinding } from '../integrations/widget/index.js';
import { allowedOrigins } from '../middleware/cors.js';

const SITE_ROUTE = /^\/api\/widget\/([^/]+)\/(?:config|sessions)$/;
const ALLOW_METHODS = 'GET, POST, OPTIONS';
const ALLOW_HEADERS = 'Content-Type';
const PREFLIGHT_MAX_AGE_S = '600';

async function bindingOrigin(path: string, origin: string | undefined): Promise<string | null> {
  if (!origin) return null;
  const siteKey = SITE_ROUTE.exec(path)?.[1];
  if (!siteKey) return null;
  // an origin on the global list is the global middleware's to answer, credentials and all
  if (allowedOrigins().includes(origin)) return null;
  const binding = await activeWidgetBinding({ siteKey });
  const said = origin.toLowerCase();
  return binding?.config.allowedOrigins.includes(said) ? origin : null;
}

export const widgetCors = (): MiddlewareHandler => async (c, next) => {
  const origin = await bindingOrigin(c.req.path, c.req.header('origin'));
  if (!origin) return next();
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Max-Age': PREFLIGHT_MAX_AGE_S,
        Vary: 'Origin',
      },
    });
  }
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', origin);
  c.res.headers.append('Vary', 'Origin');
  // the site's page never sends a Forge credential, so it is never told it may
  c.res.headers.delete('Access-Control-Allow-Credentials');
};
