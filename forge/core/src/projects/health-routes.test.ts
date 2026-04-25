import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// Each `await db.select()...chain()` resolves with the next item from the
// queue. This mirrors drizzle's thenable QueryBuilder while keeping the test
// independent of the exact chain shape (selectDistinct / leftJoin / innerJoin
// / orderBy / groupBy / limit all coexist in this handler).
const queryQueue: unknown[] = [];

function makeChain() {
  const chain: Record<string, unknown> & PromiseLike<unknown> = {} as never;
  const methods = [
    'from',
    'where',
    'leftJoin',
    'innerJoin',
    'orderBy',
    'groupBy',
    'limit',
    'offset',
    'set',
    'values',
    'returning',
  ];
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
    selectDistinct: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
  },
}));

const { projectHealthRoutes } = await import('./health-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/projects', projectHealthRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_A_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_B_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  queryQueue.length = 0;
});

async function token() {
  return signUserToken(USER_ID);
}

function authVerified() {
  // assertEmailVerified middleware: select users.emailVerifiedAt
  queryQueue.push([{ emailVerifiedAt: new Date() }]);
}

describe('GET /api/projects/health', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/projects/health');
    expect(res.status).toBe(401);
  });

  it('returns [] when caller has no visible projects', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]); // me
    queryQueue.push([]); // visibleProjects (empty → handler short-circuits)

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('200 with health rows including throughput from issue.statusChanged activity', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]); // me
    queryQueue.push([
      { id: PROJECT_A_ID, slug: 'alpha', name: 'Alpha', agentConfig: null },
      { id: PROJECT_B_ID, slug: 'beta', name: 'Beta', agentConfig: { foo: 1 } },
    ]); // visibleProjects
    queryQueue.push([
      { projectId: PROJECT_A_ID, status: 'open', n: 3 },
      { projectId: PROJECT_A_ID, status: 'in_progress', n: 1 },
      { projectId: PROJECT_B_ID, status: 'needs_info', n: 2 },
    ]); // statusRows
    queryQueue.push([]); // blockerRowsAll
    queryQueue.push([
      { projectId: PROJECT_A_ID, n: 2 },
    ]); // throughputRows — counts issue.statusChanged → closed/released in last 7 days

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      projectSlug: string;
      throughput: number;
      totalActive: number;
      pendingEscalations: number;
    }>;

    expect(body).toHaveLength(2);
    const alpha = body.find((p) => p.projectSlug === 'alpha');
    const beta = body.find((p) => p.projectSlug === 'beta');
    expect(alpha?.throughput).toBe(2);
    expect(alpha?.totalActive).toBe(4); // open(3) + in_progress(1)
    expect(beta?.throughput).toBe(0); // no qualifying activity
    expect(beta?.pendingEscalations).toBe(2); // needs_info bucket
  });

  it('200 with throughput=0 when no activity rows match (regression: empty result must not 500)', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]);
    queryQueue.push([
      { id: PROJECT_A_ID, slug: 'alpha', name: 'Alpha', agentConfig: null },
    ]);
    queryQueue.push([{ projectId: PROJECT_A_ID, status: 'open', n: 1 }]);
    queryQueue.push([]); // blockerRowsAll
    queryQueue.push([]); // throughputRows — empty (was the original 500 trigger)

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ throughput: number }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.throughput).toBe(0);
  });

  it('CEO branch: skips project-membership filter', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: true }]); // CEO
    queryQueue.push([
      { id: PROJECT_A_ID, slug: 'alpha', name: 'Alpha', agentConfig: null },
    ]); // visibleProjects (unrestricted select)
    queryQueue.push([]); // statusRows
    queryQueue.push([]); // blockerRowsAll
    queryQueue.push([{ projectId: PROJECT_A_ID, n: 5 }]); // throughputRows

    const res = await buildApp().request('/api/projects/health', {
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ throughput: number }>;
    expect(body[0]?.throughput).toBe(5);
  });
});
