import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mountRoutes } from './route-registry.js';

describe('the composed routes', () => {
  it('lets a route mounted after every router answer with no router guarding it ahead of its own', async () => {
    const app = new Hono();
    mountRoutes(app as never);
    app.get('/api/mounted-after-everything', (c) => c.text('reached its own handler'));
    const res = await app.request('/api/mounted-after-everything');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('reached its own handler');
  });

  // ISS-925: no router under /api/projects gates past its own routes, so a project route mounted
  // last answers with no session; a `use('*')` gate on any of them answered 401 here
  it('lets a project route mounted after every router answer with no session', async () => {
    const app = new Hono();
    mountRoutes(app as never);
    app.post('/api/projects/:id/mounted-after-everything', (c) => c.text(c.req.param('id')));
    const res = await app.request('/api/projects/p-1/mounted-after-everything', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('p-1');
  });
});
