// ISS-925: a project router's gate runs on its own routes alone. Mounted beside its siblings under
// one prefix, a `use('*', gate)` refused any sibling route behind it by the order of mount; a router
// made by `gatedRoutes` gates each route it registers, by method and path, and nothing else.
// @direct-test-of packages/core/src/middleware/gated-routes.ts

import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { gatedRoutes } from './gated-routes.js';

const ran: string[] = [];
/** A gate that refuses any request with no `x-session` header, recording each run. */
const gate: MiddlewareHandler = async (c, next) => {
  ran.push(`${c.req.method} ${c.req.path}`);
  if (!c.req.header('x-session')) return c.json({ code: 'UNAUTHENTICATED' }, 401);
  await next();
};

function world() {
  ran.length = 0;
  const own = gatedRoutes(gate);
  own.get('/:id/things', (c) => c.text('things'));
  // the chained form names no path: it takes the path the chain last named
  own.get('/:id/things/:key', (c) => c.text('one')).put((c) => c.text('put'));
  own.on(['POST', 'PATCH'], '/:id/many', (c) => c.text('many'));
  own.all('/:id/any', (c) => c.text('any'));
  const open = new Hono();
  open.post('/:id/widget', (c) => c.text('open'));
  open.get('/:id/things/:key/public', (c) => c.text('public'));
  // a sibling's own method on a path the gated router also serves by another method
  open.delete('/:id/things/:key', (c) => c.text('deleted'));
  const app = new Hono();
  app.route('/api/projects', own);
  app.route('/api/projects', open);
  return app;
}

const call = (app: Hono, method: string, path: string, session = false) =>
  app.request(path, { method, headers: session ? { 'x-session': 'yes' } : {} });

describe('a gated router mounted ahead of an unauthenticated sibling', () => {
  it('lets the sibling answer with no session, its gate never run', async () => {
    const app = world();
    const res = await call(app, 'POST', '/api/projects/p1/widget');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('open');
    expect(ran).toEqual([]);
  });

  it('leaves a sibling route under one of its own path prefixes ungated', async () => {
    const app = world();
    expect((await call(app, 'GET', '/api/projects/p1/things/k/public')).status).toBe(200);
    expect(ran).toEqual([]);
  });

  it('gates only the methods it registered: a sibling’s other method on the same path answers', async () => {
    const app = world();
    expect((await call(app, 'DELETE', '/api/projects/p1/things/k')).status).toBe(200);
    expect(ran).toEqual([]);
  });

  it('refuses each of its own routes with no session, whichever way it registered them', async () => {
    const app = world();
    const own: [string, string][] = [
      ['GET', '/api/projects/p1/things'],
      ['GET', '/api/projects/p1/things/k'],
      ['PUT', '/api/projects/p1/things/k'],
      ['POST', '/api/projects/p1/many'],
      ['PATCH', '/api/projects/p1/many'],
      ['GET', '/api/projects/p1/any'],
      ['DELETE', '/api/projects/p1/any'],
    ];
    for (const [method, path] of own) {
      const res = await call(app, method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(ran).toHaveLength(own.length);
  });

  it('answers its own routes once the gate admits, running the gate once a request', async () => {
    const app = world();
    const res = await call(app, 'PUT', '/api/projects/p1/things/k', true);
    expect(await res.text()).toBe('put');
    expect(ran).toEqual(['PUT /api/projects/p1/things/k']);
  });

  it('a request no route serves is a 404, never a gate’s 401', async () => {
    const app = world();
    expect((await call(app, 'GET', '/api/projects/p1/nothing')).status).toBe(404);
    expect(ran).toEqual([]);
  });
});
