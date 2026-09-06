// Pins the Hono semantics the /api/issues mounts depend on:
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

/** A capability-authenticated sub-app: no session guard of its own. */
function publicSubApp() {
  const app = new Hono();
  app.get('/callback/:hash', (c) => {
    const hash = c.req.param('hash');
    if (!/^[a-f0-9]{16,64}$/.test(hash)) return c.json({ code: 'BAD_REQUEST' }, 400);
    return c.json({ ok: 'callback' });
  });
  return app;
}

/**
 * Mirrors `issueExtrasRoutes`: `use('*', requireAuth(), assertEmailVerified())`.
 * Unlike `guardedSubApp` above it rejects a DEVICE token, which is the whole
 * point — that is the caller `requireAnyAuth` admits and this one must not.
 */
function strictUserSubApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (!(c.req.header('Authorization') ?? '').startsWith('Bearer user-')) {
      return c.json({ code: 'UNAUTHENTICATED' }, 401);
    }
    await next();
  });
  app.get('/list', (c) => c.json({ ok: 'strict-list' }));
  return app;
}

/**
 * Mirrors `issueAttachmentRoutes`: a router with its OWN, deliberately weaker
 * guard (`requireAnyAuth` — user JWT, PAT, or device token). `scoped: false`
 * reproduces the ISS-719 shape, where the guard is registered on `'*'` and so
 * spills onto every sibling router's paths.
 */
function permissiveSubApp(opts: { scoped: boolean }) {
  const app = new Hono();
  const anyAuth = async (
    c: Parameters<Parameters<typeof app.use>[1]>[0],
    next: () => Promise<void>,
  ) => {
    const h = c.req.header('Authorization') ?? '';
    if (!h.startsWith('Bearer user-') && !h.startsWith('Bearer device-')) {
      return c.json({ code: 'INVALID_TOKEN' }, 401);
    }
    await next();
  };
  app.use(opts.scoped ? '/:id/attachments' : '*', anyAuth);
  app.post('/:id/attachments', (c) => c.json({ ok: 'attached' }));
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

// cm:edge lockstep -> packages/core/src/index.ts — these three cases encode the /api/issues mount contract; if the order or the guard scoping there changes, change this together
describe('two sub-apps that BOTH carry a guard (the /api/issues shape)', () => {
  const deviceAuth = { Authorization: 'Bearer device-1' };

  it("strict guard mounted first shadows the permissive router's own route", async () => {
    const app = new Hono();
    app.route('/api/y', strictUserSubApp());
    app.route('/api/y', permissiveSubApp({ scoped: false }));

    // cm:why a device token is exactly the caller requireAnyAuth exists to admit and requireAuth rejects, so a 401 UNAUTHENTICATED here proves the strict guard answered on a path it does not own
    const res = await app.request('/api/y/abc/attachments', {
      method: 'POST',
      headers: deviceAuth,
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('guards COMPOSE — a permissive one mounted first does not weaken the strict one', async () => {
    const app = new Hono();
    app.route('/api/y', permissiveSubApp({ scoped: false }));
    app.route('/api/y', strictUserSubApp());

    // cm:guard mounting a weaker guard first does NOT bypass a stricter one — both wildcards run in registration order, so the strict guard still rejects a device token on its own route; do not "fix" a shadowing bug by loosening a guard on the assumption that the later one is skipped
    const res = await app.request('/api/y/list', { headers: deviceAuth });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });

    // cm:why a real user token passes BOTH guards and reaches the strict router's handler — the composition is not a rejection-only path
    const ok = await app.request('/api/y/list', { headers: { Authorization: 'Bearer user-1' } });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ ok: 'strict-list' });
  });

  it('scoping the permissive guard to its own path keeps both routers correct', async () => {
    const app = new Hono();
    app.route('/api/y', permissiveSubApp({ scoped: true }));
    app.route('/api/y', strictUserSubApp());

    const attached = await app.request('/api/y/abc/attachments', {
      method: 'POST',
      headers: deviceAuth,
    });
    expect(attached.status).toBe(200);
    await expect(attached.json()).resolves.toEqual({ ok: 'attached' });

    const unauthed = await app.request('/api/y/list');
    expect(unauthed.status).toBe(401);
    await expect(unauthed.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
  });
});

// cm:edge lockstep -> packages/core/src/index.ts — the callback sub-app mounted at the broad `/api` prefix; if that mount moves, or its guard scope changes, change this together
describe('a guarded sub-app at the BROAD /api prefix (the github-callback shape)', () => {
  const callbackSubApp = (scope: '*' | '/integrations/github/*') => {
    const sub = new Hono();
    sub.use(scope, async (c, next) => {
      if (c.req.header('Authorization') !== 'Bearer user-1') {
        return c.json({ code: 'UNAUTHENTICATED' }, 401);
      }
      await next();
    });
    sub.get('/integrations/github/manifest-callback', (c) => c.json({ ok: 'callback' }));
    return sub;
  };

  const webhookSubApp = () => {
    const sub = new Hono();
    sub.post('/in/:slug', (c) => c.json({ accepted: true }));
    return sub;
  };

  it("a '*' guard at /api reaches routes it does not own, including public ones", async () => {
    const app = new Hono();
    app.route('/api', callbackSubApp('*'));
    app.route('/api/webhooks', webhookSubApp());

    // cm:why the inbound webhook is authenticated by HMAC and must stay reachable without a session — a 401 here is a provider's delivery being rejected by a guard belonging to an unrelated feature
    const res = await app.request('/api/webhooks/in/demo', { method: 'POST' });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('scoping that guard to its own path leaves the public route public', async () => {
    const app = new Hono();
    app.route('/api', callbackSubApp('/integrations/github/*'));
    app.route('/api/webhooks', webhookSubApp());

    const hook = await app.request('/api/webhooks/in/demo', { method: 'POST' });
    expect(hook.status).toBe(200);
    await expect(hook.json()).resolves.toEqual({ accepted: true });

    const callback = await app.request('/api/integrations/github/manifest-callback');
    expect(callback.status).toBe(401);
  });
});
