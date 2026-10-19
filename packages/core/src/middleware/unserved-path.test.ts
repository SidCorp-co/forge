/**
 * ISS-1305 — which paths the app serves is read off its route table, so the answer for one it does
 * not is a 404 whatever gate would have run first.
 *
 * The apps here are composed the way index.ts composes its own: a router-wide guard on a sub-app
 * mounted under a prefix, which is what answers 401 ahead of routing.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { answerUnservedPath } from './unserved-path.js';

function composed() {
  const app = new Hono();
  app.notFound((c) =>
    c.json({ code: 'NOT_FOUND', message: `Not Found: ${c.req.method} ${c.req.path}` }, 404),
  );
  app.use(
    '/api/*',
    answerUnservedPath(() => app),
  );
  const guarded = new Hono();
  guarded.use('*', async (c) => c.json({ code: 'UNAUTHENTICATED' }, 401));
  guarded.get('/things', (c) => c.json({ ok: true }));
  app.route('/api/things-area', guarded);
  app.get('/api/open', (c) => c.json({ ok: true }));
  return app;
}

describe('answerUnservedPath', () => {
  it('lets a request for a served path reach the gate in front of its route', async () => {
    const res = await composed().request('/api/things-area/things');
    expect(res.status).toBe(401);
  });

  it('answers 404 naming the path where a gate that covers the prefix would have said 401', async () => {
    const res = await composed().request('/api/things-area/no-such', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      code: 'NOT_FOUND',
      message: 'Not Found: POST /api/things-area/no-such',
    });
  });

  it('does not take a path that only a gate matches for one a route serves', async () => {
    const res = await composed().request('/api/things-area/things', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('answers a HEAD request for a served GET route as the route does', async () => {
    const res = await composed().request('/api/open', { method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('serves a route registered after the middleware was mounted, with no list of paths of its own', async () => {
    const app = composed();
    app.get('/api/late', (c) => c.json({ late: true }));
    const res = await app.request('/api/late');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ late: true });
  });

  it('answers 404 for a path no route was ever registered at, as the table says', async () => {
    const res = await composed().request('/api/never-registered');
    expect(res.status).toBe(404);
  });

  it('leaves a path outside /api to the app', async () => {
    const app = composed();
    app.get('/elsewhere', (c) => c.text('here'));
    expect((await app.request('/elsewhere')).status).toBe(200);
  });
});
