/**
 * ISS-884 — the per-issue rollup the interventions metric is read through.
 *
 * Split from `analytics-routes.test.ts` because the bucketing is the whole
 * subject: the endpoint's other suites assert shapes, this one asserts that a
 * source name lands in the bucket it names.
 */

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbExecute = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    execute: (q: unknown) => dbExecute(q),
  },
}));

const visibleIds = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadVisibleProjectIds: (...args: unknown[]) => visibleIds(...args),
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

describe('GET /api/pipeline/interventions', () => {
  // cm:guard the view emits `manual_` as a PREFIX with the row's own action appended, not the fixed `manual_cancel` it began as. This suite exists because the rollup read it as a fixed value until ISS-884 and charted every resume, answer and inject as a run flip — the mislabelling migration 0181 was written to end, reintroduced one layer above it.
  it('buckets every source the view actually emits, and never lands one in the wrong bucket', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    visibleIds.mockResolvedValueOnce(['p-1']);
    dbExecute.mockResolvedValueOnce([
      {
        source: 'wedge',
        project_id: 'p-1',
        issue_id: 'i-1',
        occurred_at: '2026-09-05T05:00:00Z',
        detail: 'w',
      },
      {
        source: 'manual_cancel',
        project_id: 'p-1',
        issue_id: 'i-1',
        occurred_at: '2026-09-05T04:00:00Z',
        detail: 'c',
      },
      {
        source: 'manual_resume',
        project_id: 'p-1',
        issue_id: 'i-1',
        occurred_at: '2026-09-05T03:00:00Z',
        detail: 'r',
      },
      {
        source: 'manual_inject',
        project_id: 'p-1',
        issue_id: 'i-1',
        occurred_at: '2026-09-05T02:00:00Z',
        detail: 'j',
      },
      {
        source: 'direct_sql',
        project_id: 'p-1',
        issue_id: 'i-1',
        occurred_at: '2026-09-05T01:00:00Z',
        detail: 'job running→cancelled by forge [psql]',
      },
      {
        source: 'user_run_flip',
        project_id: 'p-1',
        issue_id: 'i-1',
        occurred_at: '2026-09-05T00:00:00Z',
        detail: 'f',
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/interventions?days=30', { token }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      byIssue: Array<{
        wedges: number;
        manualJobActions: number;
        userRunFlips: number;
        directSql: number;
        total: number;
      }>;
    };
    expect(body.total).toBe(6);
    expect(body.byIssue).toHaveLength(1);
    expect(body.byIssue[0]).toMatchObject({
      wedges: 1,
      manualJobActions: 3,
      userRunFlips: 1,
      directSql: 1,
      total: 6,
    });
  });

  it('counts a hand-written flip toward the issue it was performed on', async () => {
    const token = await signUserToken('u-1');
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    visibleIds.mockResolvedValueOnce(['p-1']);
    dbExecute.mockResolvedValueOnce([
      {
        source: 'direct_sql',
        project_id: 'p-1',
        issue_id: 'i-9',
        occurred_at: '2026-09-05T01:00:00Z',
        detail: 'run running→cancelled by forge [psql]',
      },
    ]);

    const app = buildApp();
    const res = await app.fetch(req('/api/pipeline/interventions', { token }));

    const body = (await res.json()) as {
      total: number;
      byIssue: Array<{ issueId: string; directSql: number; total: number }>;
      events: Array<{ source: string; detail: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.byIssue[0]).toMatchObject({ issueId: 'i-9', directSql: 1, total: 1 });
    expect(body.events[0]?.source).toBe('direct_sql');
  });
});
