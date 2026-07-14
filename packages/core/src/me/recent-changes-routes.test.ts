import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const queryQueue: unknown[] = [];

function makeChain() {
  const chain: Record<string, unknown> & PromiseLike<unknown> = {} as never;
  const methods = ['from', 'where', 'innerJoin', 'orderBy', 'limit'];
  for (const m of methods) (chain as Record<string, unknown>)[m] = () => chain;
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) => {
    const result = queryQueue.shift() ?? [];
    return Promise.resolve(result).then(resolve, reject);
  };
  return chain;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => makeChain(),
  },
}));

const visibleIdsMock = vi.fn(async (_userId: string) => [] as string[]);
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadVisibleProjectIds: (...args: unknown[]) => visibleIdsMock(...(args as [string])),
}));

const { meRecentChangesRoutes } = await import('./recent-changes-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/me', meRecentChangesRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  queryQueue.length = 0;
  visibleIdsMock.mockReset();
  visibleIdsMock.mockResolvedValue([]);
});

async function token() {
  return signUserToken(USER_ID);
}

function authVerified() {
  queryQueue.push([{ emailVerifiedAt: new Date() }]);
}

describe('GET /api/me/recent-changes', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/me/recent-changes');
    expect(res.status).toBe(401);
  });

  it('returns empty items when caller has no visible projects', async () => {
    authVerified();
    visibleIdsMock.mockResolvedValue([]);

    const res = await buildApp().request('/api/me/recent-changes', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('200 with recently-updated issues across visible projects, newest first', async () => {
    authVerified();
    visibleIdsMock.mockResolvedValue([PROJECT_ID]);
    const updatedAt = new Date('2026-07-10T10:00:00Z');
    queryQueue.push([
      {
        id: ISSUE_ID,
        issSeq: 665,
        title: 'Redo overview',
        status: 'developed',
        updatedAt,
        projectSlug: 'forge-dev',
        projectName: 'Forge Dev',
      },
    ]);

    const res = await buildApp().request('/api/me/recent-changes', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; issSeq: number; status: string; projectSlug: string }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: ISSUE_ID,
      issSeq: 665,
      status: 'developed',
      projectSlug: 'forge-dev',
    });
  });

  it('400 on out-of-range limit', async () => {
    authVerified();

    const res = await buildApp().request('/api/me/recent-changes?limit=0', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(400);
  });
});
