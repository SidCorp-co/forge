// Pins the Hono semantics the /api/issues and /api/runners mounts depend on:
// when two sub-apps share a prefix and one registers a `use('*')` guard, the
// guard covers the OTHER sub-app's paths too. Only registration order decides
// whether the unguarded handler is reachable. ISS-719 / ISS-720 were both this.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

/** Mirrors `requireAuth()`: a wildcard guard that rejects before any handler. */
function guardedSubApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (!c.req.header('Authorization')) return c.json({ code: 'UNAUTHENTICATED' }, 401);
    await next();
  });
  app.get('/list', (c) => c.json({ ok: 'guarded-list' }));
  return app;
}

/** Mirrors `runnerCallbackRoutes`: capability-authenticated, no session guard. */
function publicSubApp() {
  const app = new Hono();
  app.get('/callback/:hash', (c) => {
    const hash = c.req.param('hash');
    if (!/^[a-f0-9]{16,64}$/.test(hash)) return c.json({ code: 'BAD_REQUEST' }, 400);
    return c.json({ ok: 'callback' });
  });
  return app;
}

describe('two sub-apps sharing one prefix', () => {
  it("a guarded sub-app mounted FIRST shadows the public sub-app's routes", async () => {
    const app = new Hono();
    app.route('/api/x', guardedSubApp());
    app.route('/api/x', publicSubApp());

    // cm:why no Authorization header — the public handler would answer 400 (bad hash), so a 401 here proves the guard ran first
    const res = await app.request('/api/x/callback/NOT-A-HASH');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('mounting the public sub-app FIRST keeps its routes reachable', async () => {
    const app = new Hono();
    app.route('/api/x', publicSubApp());
    app.route('/api/x', guardedSubApp());

    const res = await app.request('/api/x/callback/NOT-A-HASH');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ code: 'BAD_REQUEST' });
  });

  it('the guard still protects its own routes when mounted second', async () => {
    const app = new Hono();
    app.route('/api/x', publicSubApp());
    app.route('/api/x', guardedSubApp());

    expect((await app.request('/api/x/list')).status).toBe(401);

    const authed = await app.request('/api/x/list', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(authed.status).toBe(200);
    await expect(authed.json()).resolves.toEqual({ ok: 'guarded-list' });
  });
});
