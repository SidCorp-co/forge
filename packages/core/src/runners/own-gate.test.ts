import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

const reached = () => {
  throw new Error('handler reached without an auth gate');
};
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: vi.fn(reached),
  loadVisibleProjectIds: vi.fn(reached),
}));

const { projectRunnerRoutes } = await import('./project-routes.js');
const { deviceOrgRoutes } = await import('../devices/org-routes.js');

const ID = '00000000-0000-4000-8000-000000000001';

function alone(prefix: string, router: Hono<never>): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: err.message }, status as 401);
  });
  app.route(prefix, router);
  return app;
}

describe('a router mounted alone brings its own auth gate', () => {
  it.each([
    ['GET', `/api/projects/${ID}/runners`],
    ['DELETE', `/api/projects/${ID}/runners/${ID}`],
  ])('projectRunnerRoutes refuses %s %s with no credential', async (method, path) => {
    const res = await alone('/api/projects', projectRunnerRoutes as never).request(path, {
      method,
    });
    expect(res.status).toBe(401);
  });

  it('deviceOrgRoutes refuses GET /api/orgs/:orgId/devices with no credential', async () => {
    const res = await alone('/api/orgs', deviceOrgRoutes as never).request(
      `/api/orgs/${ID}/devices`,
    );
    expect(res.status).toBe(401);
  });
});
