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
});
