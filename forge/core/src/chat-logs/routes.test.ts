import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

// Thenable chain mock — every `await db.select()...chain()` resolves with the
// next item from the queue. Decouples tests from drizzle's exact chain shape
// so listQuerySchema's omitted-projectSlug branch (which adds users +
// selectDistinct + leftJoin steps) doesn't require restructuring fixtures.
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

const projectAccess = vi.fn();
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const { chatLogRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/chat-logs', chatLogRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const LOG_ID = '33333333-3333-4333-8333-333333333333';
const SLUG = 'my-project';

beforeEach(() => {
  vi.clearAllMocks();
  queryQueue.length = 0;
  projectAccess.mockReset();
});

function authVerified() {
  queryQueue.push([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('GET /api/chat-logs', () => {
  it('200 with empty list when projectSlug omitted and caller has no visible projects', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]); // me lookup
    queryQueue.push([]); // visible projects (selectDistinct ... leftJoin ... where) → empty

    const res = await buildApp().request('/api/chat-logs', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { pagination: { total: number } } };
    expect(body.data).toEqual([]);
    expect(body.meta.pagination.total).toBe(0);
  });

  it('200 across visible projects when projectSlug omitted', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: false }]); // me
    queryQueue.push([{ slug: 'alpha' }, { slug: 'beta' }]); // visible projects
    queryQueue.push([
      { id: LOG_ID, projectSlug: 'alpha', query: 'q1', reply: 'r1' },
    ]); // rows
    queryQueue.push([{ n: 1 }]); // count

    const res = await buildApp().request('/api/chat-logs', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string }>;
      meta: { pagination: { total: number } };
    };
    expect(body.data).toHaveLength(1);
    expect(body.meta.pagination.total).toBe(1);
  });

  it('CEO branch: projectSlug omitted returns aggregated logs unrestricted', async () => {
    authVerified();
    queryQueue.push([{ id: USER_ID, isCeo: true }]); // me — CEO
    queryQueue.push([{ slug: 'alpha' }]); // unrestricted projects.select
    queryQueue.push([{ id: LOG_ID, projectSlug: 'alpha' }]); // rows
    queryQueue.push([{ n: 1 }]); // count

    const res = await buildApp().request('/api/chat-logs', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ projectSlug: string }> };
    expect(body.data[0]?.projectSlug).toBe('alpha');
  });

  it('404 when projectSlug provided but unknown', async () => {
    authVerified();
    queryQueue.push([]); // resolveProjectIdBySlug → no row

    const res = await buildApp().request(`/api/chat-logs?projectSlug=${SLUG}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/chat-logs/:id', () => {
  it('returns log + checks access', async () => {
    authVerified();
    queryQueue.push([{ id: LOG_ID, projectSlug: SLUG, query: 'q', reply: 'r' }]); // log row
    queryQueue.push([{ id: PROJECT_ID }]); // resolveProjectIdBySlug
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'member' });

    const res = await buildApp().request(`/api/chat-logs/${LOG_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(LOG_ID);
  });
});

describe('PATCH /api/chat-logs/:id', () => {
  it('403 non-owner trying to update', async () => {
    authVerified();
    queryQueue.push([{ id: LOG_ID, projectSlug: SLUG }]);
    queryQueue.push([{ id: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: 'x', role: 'member' });

    const res = await buildApp().request(`/api/chat-logs/${LOG_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ qaRating: 'bad' }),
    });
    expect(res.status).toBe(403);
  });

  it('200 owner can rate', async () => {
    authVerified();
    queryQueue.push([{ id: LOG_ID, projectSlug: SLUG }]);
    queryQueue.push([{ id: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: USER_ID, role: 'owner' });
    queryQueue.push([{ id: LOG_ID, qaRating: 'good' }]); // update returning

    const res = await buildApp().request(`/api/chat-logs/${LOG_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ qaRating: 'good' }),
    });
    expect(res.status).toBe(200);
  });
});
