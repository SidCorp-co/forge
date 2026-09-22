import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test', EMBEDDINGS_MODEL: 'test-model' },
}));

/**
 * The only query any refusal under test reaches is `assertEmailVerified`'s user row; every other
 * read sits behind a validator or behind `assertProjectAccess`, which is mocked below.
 */
vi.mock('../../db/client.js', () => {
  const verifiedUser = [{ email: 'dev@example.com', emailVerifiedAt: new Date() }];
  const limit = () => Promise.resolve(verifiedUser);
  const where = () => ({ limit });
  const from = () => ({ where, limit });
  return { db: { select: () => ({ from }) } };
});

const assertProjectAccess = vi.fn();
vi.mock('../../lib/authz.js', () => ({
  assertProjectAccess: (...args: unknown[]) => assertProjectAccess(...args),
}));

const { backlogStreamRoutes } = await import('./routes.js');
const { errorHandler } = await import('../../middleware/error.js');
type ErrorEnv = { Variables: import('../../middleware/request-id.js').RequestIdVars };
const { signUserToken } = await import('../../auth/jwt.js');
const { __resetRateLimitStore } = await import('../../middleware/rate-limit.js');

function buildApp() {
  const app = new Hono<ErrorEnv>();
  app.route('/api/projects', backlogStreamRoutes);
  app.onError(errorHandler);
  return app;
}

async function call(path: string, auth = true) {
  const headers = auth ? { authorization: `Bearer ${await signUserToken(USER)}` } : {};
  return buildApp().request(`/api/projects/${PROJECT}/backlog${path}`, { headers });
}

beforeEach(() => {
  __resetRateLimitStore();
  assertProjectAccess.mockReset();
  assertProjectAccess.mockResolvedValue({ role: 'viewer' });
});

describe('backlog stream routes — what they refuse', () => {
  it('refuses an unauthenticated caller on ordering', async () => {
    expect((await call('/ordering', false)).status).toBe(401);
  });

  it('refuses an unauthenticated caller on alike', async () => {
    expect((await call('/alike', false)).status).toBe(401);
  });

  it('refuses a caller holding no role on the project', async () => {
    const { HTTPException } = await import('hono/http-exception');
    assertProjectAccess.mockRejectedValue(
      new HTTPException(403, { message: 'forbidden', cause: { code: 'FORBIDDEN' } }),
    );
    expect((await call('/ordering')).status).toBe(403);
  });

  it('names limit and its range rather than clamping it', async () => {
    const res = await call('/ordering?limit=99999');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('limit must be between 1 and 5000');
  });

  it('names budgetMs and its range rather than clamping it', async () => {
    const res = await call('/ordering?budgetMs=1');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('budgetMs must be between 1000 and 600000');
  });

  it('names topK and its range rather than clamping it', async () => {
    const res = await call('/alike?topK=500');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('topK must be between 1 and 50');
  });

  it('refuses a status the tracker does not hold rather than dropping it', async () => {
    const res = await call('/ordering?status=open,banana');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('each status must be one of');
  });

  it('refuses a query parameter it does not take, and lists the ones it does', async () => {
    const res = await call('/ordering?sort=createdAt');
    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('UNKNOWN_QUERY_PARAMETER');
    expect(body).toContain('budgetMs');
  });

  it('refuses a body value that is neither true nor false', async () => {
    const res = await call('/ordering?body=yes');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('body must be true or false');
  });
});

describe('backlog stream routes — what one request costs', () => {
  it('charges its own bucket, not the one ordinary searches share', async () => {
    const { RULES } = await import('../../config/rate-limits.js');
    expect(RULES.backlogStream.max).not.toBe(RULES.memorySearch.max);
    expect(RULES.backlogStream.by).toBe('user');
  });

  it('ticks that bucket exactly once per request, whatever the request reads inside', async () => {
    const res = await call('/ordering?limit=5000');
    // The refusal below it would be a second tick; a 200 stream would be one tick too.
    const limit = Number(res.headers.get('X-RateLimit-Limit'));
    const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
    expect(limit - remaining).toBe(1);
  });
});
