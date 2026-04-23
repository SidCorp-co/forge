import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

let queuedResults: Array<Array<Record<string, unknown>>> = [];

vi.mock('../db/client.js', () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.limit = async (_n: number) => queuedResults.shift() ?? [];
  return { db: chain };
});

const { errorHandler } = await import('../middleware/error.js');
const { projectRoutes } = await import('./projects.js');
const { signUserToken } = await import('../auth/jwt.js');

function makeApp() {
  const app = new Hono();
  app.route('/api/projects', projectRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

const userRow = { id: 'user-1', email: 'a@b.com', emailVerifiedAt: null };
const projectRow = {
  id: 'proj-1',
  slug: 'demo',
  name: 'Demo',
  ownerId: 'user-1',
};

beforeEach(() => {
  queuedResults = [];
});

describe('GET /api/projects/:id', () => {
  it('returns 200 with the project for an authenticated member', async () => {
    const token = await signUserToken(userRow.id);
    queuedResults = [[userRow], [{ userId: userRow.id }], [projectRow]];
    const app = makeApp();
    const res = await app.request('/api/projects/proj-1', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(projectRow);
  });

  it('returns 403 FORBIDDEN when the user is not a project member', async () => {
    const token = await signUserToken(userRow.id);
    queuedResults = [[userRow], []];
    const app = makeApp();
    const res = await app.request('/api/projects/proj-1', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns 403 for an unknown project id (policy runs before row lookup)', async () => {
    const token = await signUserToken(userRow.id);
    queuedResults = [[userRow], []];
    const app = makeApp();
    const res = await app.request('/api/projects/missing', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns 401 UNAUTHENTICATED without an auth token', async () => {
    const app = makeApp();
    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
