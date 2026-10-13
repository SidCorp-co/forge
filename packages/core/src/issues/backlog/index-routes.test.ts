import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test', EMBEDDINGS_MODEL: 'test-model' },
}));

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

const readRanking = vi.fn();
const readNeighbours = vi.fn();
vi.mock('./rank-read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rank-read.js')>()),
  readRanking: (...args: unknown[]) => readRanking(...args),
}));
vi.mock('./alike-read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./alike-read.js')>()),
  readNeighbours: (...args: unknown[]) => readNeighbours(...args),
}));

const { backlogStreamRoutes } = await import('./routes.js');
const { errorHandler } = await import('../../middleware/error.js');
type ErrorEnv = { Variables: import('../../middleware/request-id.js').RequestIdVars };
const { signUserToken } = await import('../../auth/jwt.js');
const { __resetRateLimitStore } = await import('../../middleware/rate-limit.js');
const { BacklogIndexRefused } = await import('./rank-read.js');

async function call(path: string, auth = true) {
  const app = new Hono<ErrorEnv>();
  app.route('/api/projects', backlogStreamRoutes);
  app.onError(errorHandler);
  const headers = auth ? { authorization: `Bearer ${await signUserToken(USER)}` } : {};
  return app.request(`/api/projects/${PROJECT}/backlog${path}`, { headers });
}

beforeEach(() => {
  __resetRateLimitStore();
  assertProjectAccess.mockReset();
  assertProjectAccess.mockResolvedValue({ role: 'viewer' });
  readRanking.mockReset();
  readNeighbours.mockReset();
  readRanking.mockResolvedValue({ ranking: [] });
  readNeighbours.mockResolvedValue({ seeds: [] });
});

describe('backlog index routes — what they refuse', () => {
  it.each(['/ranking', '/neighbours'])('refuses an unauthenticated caller on %s', async (path) => {
    expect((await call(path, false)).status).toBe(401);
    expect(readRanking).not.toHaveBeenCalled();
    expect(readNeighbours).not.toHaveBeenCalled();
  });

  it('names limit and its range on the ranking rather than clamping it', async () => {
    for (const bad of ['0', '501']) {
      const res = await call(`/ranking?limit=${bad}`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('limit must be between 1 and 500');
    }
    expect(readRanking).not.toHaveBeenCalled();
  });

  it('names catchUpMs and its range, at both edges', async () => {
    for (const path of ['/ranking', '/neighbours']) {
      for (const bad of ['-1', '30001']) {
        const res = await call(`${path}?catchUpMs=${bad}`);
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain('catchUpMs must be between 0 and 30000');
      }
    }
  });

  it('names topK past what an issue keeps, and a non-number', async () => {
    const res = await call('/neighbours?topK=11');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('topK must be between 1 and 10');
    expect((await call('/neighbours?topK=lots')).status).toBe(400);
  });

  it('refuses a parameter it does not take, such as the retired windowCap', async () => {
    const res = await call('/ranking?windowCap=40');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('UNKNOWN_QUERY_PARAMETER');
  });

  it('refuses eligible that is neither true nor false', async () => {
    const res = await call('/ranking?eligible=yes');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('eligible must be true or false');
  });

  it('refuses a caller with no role before it reads anything', async () => {
    const { HTTPException } = await import('hono/http-exception');
    assertProjectAccess.mockRejectedValue(
      new HTTPException(403, { message: 'forbidden', cause: { code: 'FORBIDDEN' } }),
    );
    expect((await call('/ranking')).status).toBe(403);
    expect(readRanking).not.toHaveBeenCalled();
  });
});

describe('backlog index routes — what they pass on', () => {
  it('hands the parsed query, defaults filled, to the read', async () => {
    expect((await call('/ranking?eligible=true&limit=7')).status).toBe(200);
    expect(readRanking).toHaveBeenCalledWith({
      projectId: PROJECT,
      limit: 7,
      eligibleOnly: true,
      catchUpMs: 5000,
    });
    expect((await call('/neighbours?after=12')).status).toBe(200);
    expect(readNeighbours).toHaveBeenCalledWith({
      projectId: PROJECT,
      topK: 10,
      limit: 500,
      after: 12,
      catchUpMs: 5000,
    });
  });

  it('answers an index that is behind with its own refusal as 409, not a 200 or a 500', async () => {
    readRanking.mockRejectedValue(
      new BacklogIndexRefused('RANK_INDEX_INCOMPLETE', 'two issues are unscored', {}),
    );
    const res = await call('/ranking');
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('RANK_INDEX_INCOMPLETE');
  });
});
