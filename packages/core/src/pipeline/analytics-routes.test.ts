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
  app.route('/api/projects', routes.projectCostAnalyticsRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_UUID = '33333333-3333-4333-8333-333333333333';
const ISSUE_UUID = '44444444-4444-4444-8444-444444444444';

// Stack the three lookups assertProjectMember performs after the email-verify
// pre-check. Call order matters: (1) users.isCeo, (2) projects.ownerId,
// (3) projectMembers row (skipped when CEO or owner).
function mockMembership(opts: {
  isCeo?: boolean;
  ownerId?: string;
  memberOf?: boolean;
  projectExists?: boolean;
}) {
  selectLimit
    .mockResolvedValueOnce([{ emailVerifiedAt: new Date() }])
    .mockResolvedValueOnce([{ isCeo: !!opts.isCeo }])
    .mockResolvedValueOnce(
      opts.projectExists === false ? [] : [{ ownerId: opts.ownerId ?? 'other-owner' }],
    );
  if (!opts.isCeo && opts.ownerId !== 'u-1' && opts.projectExists !== false) {
    selectLimit.mockResolvedValueOnce(opts.memberOf ? [{ userId: 'u-1' }] : []);
  }
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

describe('GET /api/projects/:id/analytics/cost-summary', () => {
  it('401 without token', async () => {
    const app = buildApp();
    const res = await app.fetch(req(`/api/projects/${PROJECT_UUID}/analytics/cost-summary`));
    expect(res.status).toBe(401);
  });

  it('400 on bad project UUID', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const app = buildApp();
    const res = await app.fetch(req('/api/projects/not-uuid/analytics/cost-summary', { token }));
    expect(res.status).toBe(400);
  });

  it('400 on days out of range', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/cost-summary?days=999`, { token }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when caller is not a project member', async () => {
    const token = await signUserToken('u-1');
    mockMembership({ ownerId: 'other-owner', memberOf: false });
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/cost-summary`, { token }),
    );
    expect(res.status).toBe(403);
  });

  it('200 mapped shape with byState avgPerRun and byIssue', async () => {
    const token = await signUserToken('u-1');
    mockMembership({ ownerId: 'u-1' });
    dbExecute
      .mockResolvedValueOnce([{ total: '12.5' }])
      .mockResolvedValueOnce([
        { step: 'plan', total: '8', runs: 4 },
        { step: 'code', total: '4.5', runs: 1 },
      ])
      .mockResolvedValueOnce([
        { issue_id: ISSUE_UUID, total: '9' },
        { issue_id: 'i-2', total: '3.5' },
      ]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/cost-summary?days=30`, { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      byState: Array<{ state: string; total: number; runs: number; avgPerRun: number }>;
      byIssue: Array<{ issueId: string; total: number }>;
    };
    expect(body.total).toBe(12.5);
    expect(body.byState).toHaveLength(2);
    expect(body.byState[0]).toEqual({ state: 'plan', total: 8, runs: 4, avgPerRun: 2 });
    expect(body.byState[1]?.avgPerRun).toBe(4.5);
    expect(body.byIssue).toEqual([
      { issueId: ISSUE_UUID, total: 9 },
      { issueId: 'i-2', total: 3.5 },
    ]);
  });
});

describe('GET /api/projects/:id/analytics/cost-trend', () => {
  it('401 without token', async () => {
    const app = buildApp();
    const res = await app.fetch(req(`/api/projects/${PROJECT_UUID}/analytics/cost-trend`));
    expect(res.status).toBe(401);
  });

  it('400 on unknown step', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/cost-trend?step=not-a-type`, { token }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when not a project member', async () => {
    const token = await signUserToken('u-1');
    mockMembership({ ownerId: 'other-owner', memberOf: false });
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/cost-trend`, { token }),
    );
    expect(res.status).toBe(403);
  });

  it('200 daily series with empty annotations when activity_log returns none', async () => {
    const token = await signUserToken('u-1');
    mockMembership({ isCeo: true });
    dbExecute
      .mockResolvedValueOnce([
        { date: '2026-05-22', cost: '1.5', runs: 3 },
        { date: '2026-05-23', cost: '0.25', runs: 1 },
      ])
      .mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/cost-trend?step=plan`, { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      daily: Array<{ date: string; cost: number; runs: number }>;
      annotations: Array<{ ts: string; message: string; kind: string }>;
    };
    expect(body.daily).toEqual([
      { date: '2026-05-22', cost: 1.5, runs: 3 },
      { date: '2026-05-23', cost: 0.25, runs: 1 },
    ]);
    expect(body.annotations).toEqual([]);

    // Step filter binds the literal into the SQL parameters.
    const dailyQuery = dbExecute.mock.calls[0]?.[0] as {
      queryChunks?: Array<{ value?: unknown }>;
    };
    expect(JSON.stringify(dailyQuery?.queryChunks ?? dailyQuery)).toContain('plan');
  });

  it('200 surfaces activity_log annotations with pipeline_config.updated kind', async () => {
    const token = await signUserToken('u-1');
    mockMembership({ ownerId: 'u-1' });
    dbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ts: '2026-05-20T12:34:56Z', message: 'autoCode toggled' },
        { ts: '2026-05-21T08:00:00Z', message: 'pipeline config updated' },
      ]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/cost-trend`, { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      annotations: Array<{ ts: string; message: string; kind: string }>;
    };
    expect(body.annotations).toHaveLength(2);
    expect(body.annotations[0]).toEqual({
      ts: '2026-05-20T12:34:56Z',
      message: 'autoCode toggled',
      kind: 'pipeline_config.updated',
    });
    expect(body.annotations[1]?.kind).toBe('pipeline_config.updated');
  });
});

describe('GET /api/projects/:id/analytics/outliers', () => {
  it('401 without token', async () => {
    const app = buildApp();
    const res = await app.fetch(req(`/api/projects/${PROJECT_UUID}/analytics/outliers`));
    expect(res.status).toBe(401);
  });

  it('400 on bad days', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/outliers?days=0`, { token }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when not a project member', async () => {
    const token = await signUserToken('u-1');
    mockMembership({ ownerId: 'other-owner', memberOf: false });
    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/outliers`, { token }),
    );
    expect(res.status).toBe(403);
  });

  it('200 maps rows to camelCase with dimensions and echoes threshold', async () => {
    const token = await signUserToken('u-1');
    mockMembership({ ownerId: 'u-1' });
    dbExecute.mockResolvedValueOnce([
      {
        job_id: 'j-1',
        state: 'code',
        cost: '1.25',
        issue_id: ISSUE_UUID,
        description_len: '420',
        session_depth: '12',
        threshold: '0.95',
      },
      {
        job_id: 'j-2',
        state: 'plan',
        cost: '0.95',
        issue_id: null,
        description_len: 0,
        session_depth: 0,
        threshold: '0.95',
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/outliers?days=30`, { token }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      threshold: number;
      runs: Array<{
        jobId: string;
        state: string;
        cost: number;
        issueId: string | null;
        dimensions: { descriptionLen: number; sessionDepth: number };
      }>;
    };
    expect(body.threshold).toBe(0.95);
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]).toEqual({
      jobId: 'j-1',
      state: 'code',
      cost: 1.25,
      issueId: ISSUE_UUID,
      dimensions: { descriptionLen: 420, sessionDepth: 12 },
    });
    expect(body.runs[1]?.issueId).toBeNull();
  });

  it('200 returns threshold=0 and runs=[] when no rows', async () => {
    const token = await signUserToken('u-1');
    mockMembership({ ownerId: 'u-1' });
    dbExecute.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.fetch(
      req(`/api/projects/${PROJECT_UUID}/analytics/outliers`, { token }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threshold: 0, runs: [] });
  });

  it('embeds percentile_disc(0.95) literal in the SQL', async () => {
    const token = await signUserToken('u-1');
    mockMembership({ ownerId: 'u-1' });
    dbExecute.mockResolvedValueOnce([]);

    const app = buildApp();
    await app.fetch(req(`/api/projects/${PROJECT_UUID}/analytics/outliers`, { token }));
    expect(dbExecute).toHaveBeenCalledTimes(1);
    const queryArg = dbExecute.mock.calls[0]?.[0] as {
      queryChunks?: Array<{ value?: unknown }>;
    };
    const serialized = JSON.stringify(queryArg?.queryChunks ?? queryArg);
    expect(serialized).toContain('percentile_disc(0.95)');
  });
});
