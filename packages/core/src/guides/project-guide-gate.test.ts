// ISS-925: the project guides router is mounted under `/api/projects` and gated every
// `/api/projects/*` request that reached it, so an unauthenticated project route had to be mounted
// ahead of it (ISS-922's server-key door). Its gate covers its own path now: a route mounted after it
// answers with no session, and a guide read with none is still refused.
// @direct-test-of packages/core/src/guides/routes.ts

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { guideRoutes } from './routes.js';

const PROJECT = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

function world() {
  const app = new Hono();
  app.route('/api', guideRoutes);
  // an unauthenticated project route mounted after the guides, as a widget or a webhook would be
  app.post('/api/projects/:id/widget-ping', (c) => c.json({ reached: c.req.param('id') }));
  return app;
}

describe('the project guides router behind /api/projects', () => {
  it('lets an unauthenticated project route mounted after it answer with no session', async () => {
    const res = await world().request(`/api/projects/${PROJECT}/widget-ping`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: PROJECT });
  });

  it('still refuses a guide read with no session', async () => {
    const res = await world().request(`/api/projects/${PROJECT}/guides/feedback`);
    expect(res.status).toBe(401);
  });
});
