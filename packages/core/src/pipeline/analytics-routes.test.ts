import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectOrderBy = vi.fn();
const selectGroupBy = vi.fn(() => ({ orderBy: selectOrderBy }));
const selectInnerJoinWhere = vi.fn(() => ({ groupBy: selectGroupBy }));
const innerJoin = vi.fn(() => ({ where: selectInnerJoinWhere }));
const leftJoinWhere = vi.fn();
const leftJoin = vi.fn(() => ({ where: leftJoinWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  innerJoin,
  leftJoin,
}));
const selectDistinctFrom = vi.fn(() => ({ leftJoin }));
const dbExecute = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    selectDistinct: vi.fn(() => ({ from: selectDistinctFrom })),
    execute: (q: unknown) => dbExecute(q),
  },
}));

const routes = await import('./analytics-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/pipeline', routes.pipelineAnalyticsRoutes);
  app.onError(errorHandler);
  return app;
}

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const { token: _t, ...rest } = init;
  return new Request(`http://localhost${path}`, { ...rest, headers });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/pipeline/throughput', () => {
  it('401 without token', async () => {
    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/throughput'));
    expect(res.status).toBe(401);
  });

  it('400 when days exceeds cap', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/throughput?days=999', { token }));
    expect(res.status).toBe(400);
  });

  it('returns [] when user has no visible projects', async () => {
    const token = await signUserToken('u-1');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'u-1', isCeo: false }]);
    leftJoinWhere.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/throughput', { token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns daily counts grouped by project for member', async () => {
    const token = await signUserToken('u-1');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'u-1', isCeo: false }]);
    leftJoinWhere.mockResolvedValueOnce([{ id: 'p-1' }]);
    selectOrderBy.mockResolvedValueOnce([
      { projectId: 'p-1', date: '2026-04-26', count: 3 },
      { projectId: 'p-1', date: '2026-04-27', count: 5 },
    ]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/throughput?days=7', { token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ date: string; count: number }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.count).toBe(3);
    expect(body[1]?.count).toBe(5);
  });

  it('scopes to projectId when caller has access', async () => {
    const token = await signUserToken('u-1');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'u-1', isCeo: false }]);
    leftJoinWhere.mockResolvedValueOnce([{ id: 'p-1' }, { id: 'p-2' }]);
    selectOrderBy.mockResolvedValueOnce([
      { projectId: 'p-1', date: '2026-04-27', count: 7 },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req(
        '/api/pipeline/throughput?projectId=11111111-1111-4111-8111-111111111111',
        { token },
      ),
    );
    expect(res.status).toBe(200);
  });

  it('returns [] when projectId is not in user visibility', async () => {
    const token = await signUserToken('u-1');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'u-1', isCeo: false }]);
    leftJoinWhere.mockResolvedValueOnce([{ id: 'p-1' }]);

    const app = buildApp();
    const res = await app.fetch(
      req(
        '/api/pipeline/throughput?projectId=22222222-2222-4222-8222-222222222222',
        { token },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('GET /api/pipeline/cycle-time', () => {
  it('401 without token', async () => {
    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time'));
    expect(res.status).toBe(401);
  });

  it('400 on bad projectId uuid', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time?projectId=not-uuid', { token }));
    expect(res.status).toBe(400);
  });

  it('returns [] when user has no visible projects', async () => {
    const token = await signUserToken('u-1');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'u-1', isCeo: false }]);
    leftJoinWhere.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time', { token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns avgHours per status', async () => {
    const token = await signUserToken('u-1');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'u-1', isCeo: false }]);
    leftJoinWhere.mockResolvedValueOnce([{ id: 'p-1' }]);
    dbExecute.mockResolvedValueOnce([
      { status: 'open', avg_hours: 4.5, n: 12 },
      { status: 'in_progress', avg_hours: 23.1, n: 8 },
    ]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/cycle-time', { token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ status: string; avgHours: number; n: number }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.status).toBe('open');
    expect(body[0]?.avgHours).toBe(4.5);
    expect(body[1]?.n).toBe(8);
  });
});

describe('GET /api/pipeline/step-durations', () => {
  it('401 without token', async () => {
    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/step-durations'));
    expect(res.status).toBe(401);
  });

  it('returns [] when user has no visible projects', async () => {
    const token = await signUserToken('u-1');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'u-1', isCeo: false }]);
    leftJoinWhere.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/step-durations', { token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('400 when days is below 1', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/step-durations?days=0', { token }));
    expect(res.status).toBe(400);
  });

  it('400 when days exceeds cap', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/step-durations?days=91', { token }));
    expect(res.status).toBe(400);
  });

  it('400 when step is not a known job type', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const app = buildApp();
    const res = await app.fetch(
      req('/api/pipeline/step-durations?step=not-a-real-type', { token }),
    );
    expect(res.status).toBe(400);
  });

  it('maps snake_case view rows to camelCase and coerces numbers', async () => {
    const token = await signUserToken('u-1');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'u-1', isCeo: false }]);
    leftJoinWhere.mockResolvedValueOnce([{ id: 'p-1' }]);
    dbExecute.mockResolvedValueOnce([
      {
        run_id: 'r-1',
        issue_id: 'i-1',
        project_id: 'p-1',
        step: 'plan',
        started_at: '2026-05-13T01:00:00Z',
        finished_at: '2026-05-13T01:00:12Z',
        duration_seconds: '12.5',
        cost_usd: '0.04',
      },
      {
        run_id: 'r-2',
        issue_id: null,
        project_id: 'p-1',
        step: 'pm',
        started_at: '2026-05-13T00:00:00Z',
        finished_at: '2026-05-13T00:00:05Z',
        duration_seconds: 5,
        cost_usd: 0,
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/step-durations', { token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      runId: string;
      issueId: string | null;
      projectId: string;
      step: string;
      startedAt: string;
      finishedAt: string;
      durationSeconds: number;
      costUsd: number;
    }>;
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      runId: 'r-1',
      issueId: 'i-1',
      projectId: 'p-1',
      step: 'plan',
      startedAt: '2026-05-13T01:00:00Z',
      finishedAt: '2026-05-13T01:00:12Z',
      durationSeconds: 12.5,
      costUsd: 0.04,
    });
    expect(body[1]?.issueId).toBeNull();
    expect(body[1]?.step).toBe('pm');
  });

  it('passes step filter into the SQL parameters', async () => {
    const token = await signUserToken('u-1');
    selectLimit
      .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'u-1', isCeo: false }]);
    leftJoinWhere.mockResolvedValueOnce([{ id: 'p-1' }]);
    dbExecute.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/step-durations?step=code', { token }));
    expect(res.status).toBe(200);
    expect(dbExecute).toHaveBeenCalledTimes(1);
    // The drizzle SQL object exposes a `.queryChunks` array; inspect it for
    // the literal 'code' that the step filter binds.
    const queryArg = dbExecute.mock.calls[0]?.[0] as {
      queryChunks?: Array<{ value?: unknown }>;
    };
    const params = JSON.stringify(queryArg?.queryChunks ?? queryArg);
    expect(params).toContain('code');
  });
});
