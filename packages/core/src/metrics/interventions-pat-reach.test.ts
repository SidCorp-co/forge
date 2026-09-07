/**
 * ISS-944 — which credential can read the interventions metric, and for which
 * project.
 *
 * The whole subject is refusals, so every assertion here is planted against a
 * shape that must be turned away: the fence is exercised end to end
 * (`requireAuth` -> `beginPatRequest` -> `runWithPatScope` -> `effectiveProjectRole`)
 * and only `auth/pat.js` and the database are stubbed. Mocking `lib/authz.js`
 * would leave the middle assertion — one project's token asking for another
 * project — passing against no fence at all.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const dbResultQueue: unknown[] = [];
function queueRows(value: unknown) {
  dbResultQueue.push(value);
}
function nextResult(): Promise<unknown> {
  if (dbResultQueue.length === 0) {
    throw new Error('interventions-pat-reach.test.ts: unexpected db call with no queued result');
  }
  return Promise.resolve(dbResultQueue.shift());
}
// biome-ignore lint/suspicious/noExplicitAny: a chainable query-builder stub answers every call shape the routers use
function chain(): any {
  // biome-ignore lint/suspicious/noExplicitAny: same stub, self-referential
  const c: any = {
    from: () => c,
    leftJoin: () => c,
    innerJoin: () => c,
    where: () => c,
    limit: () => c,
    orderBy: () => c,
    groupBy: () => c,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      nextResult().then(resolve, reject),
  };
  return c;
}

const dbExecute = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain()),
    selectDistinct: vi.fn(() => chain()),
    execute: (q: unknown) => dbExecute(q),
  },
}));

const verifyPatMock = vi.fn();
vi.mock('../auth/pat.js', async () => {
  const actual = await vi.importActual<typeof import('../auth/pat.js')>('../auth/pat.js');
  return {
    ...actual,
    verifyPat: (...args: unknown[]) => verifyPatMock(...args),
    touchPatUsage: () => {},
  };
});

const metricsRoutes = await import('./routes.js');
const analyticsRoutes = await import('../pipeline/analytics-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const PAT_TOKEN = 'forge_pat_dev_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', metricsRoutes.projectMetricsRoutes);
  app.route('/api/pipeline', analyticsRoutes.pipelineAnalyticsRoutes);
  app.onError(errorHandler);
  return app;
}

/** A token whose reach is exactly `projectIds`, as `personal_access_tokens` stores it. */
function tokenScopedTo(projectIds: string[]) {
  verifyPatMock.mockResolvedValue({
    row: {
      id: 'pat-1',
      userId: USER_ID,
      scopes: ['read', 'write'],
      projectIds,
      boundProjectId: null,
      rateLimitMax: null,
    },
  });
}

function get(path: string) {
  return buildApp().request(path, { headers: { authorization: `Bearer ${PAT_TOKEN}` } });
}

const EVENT_ROW = {
  source: 'direct_sql',
  project_id: PROJECT_A,
  issue_id: 'i-1',
  occurred_at: '2026-09-06T01:00:00Z',
  detail: 'job running→cancelled by forge [psql]',
};

const B_EVENT_ROW = { ...EVENT_ROW, project_id: PROJECT_B, issue_id: 'i-b' };

beforeEach(() => {
  vi.clearAllMocks();
  dbResultQueue.length = 0;
  dbExecute.mockReset();
});

describe('the interventions metric, read by a personal access token', () => {
  it('answers a token the rollup for a project its allowlist names', async () => {
    tokenScopedTo([PROJECT_A]);
    queueRows([{ emailVerifiedAt: new Date() }]);
    queueRows([{ orgId: 'org-1', memberRole: 'admin', orgRole: 'owner' }]);
    dbExecute.mockResolvedValueOnce([EVENT_ROW]);

    const res = await get(`/api/projects/${PROJECT_A}/metrics/interventions`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      byIssue: Array<{ issueId: string; projectId: string; directSql: number; total: number }>;
      events: Array<{ source: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.byIssue[0]).toMatchObject({
      issueId: 'i-1',
      projectId: PROJECT_A,
      directSql: 1,
      total: 1,
    });
    expect(body.events[0]?.source).toBe('direct_sql');
  });

  // cm:guard the assertion this suite exists for, and the one that goes vacuous first. It must fail because the FENCE refused, not because a stub ran out of rows: the `issue_intervention_events` read is asserted un-run, so a fence removed while the route still 404s on some later query cannot pass this.
  it('refuses the same token the project its allowlist does not name, and reads no row of it', async () => {
    tokenScopedTo([PROJECT_A]);
    queueRows([{ emailVerifiedAt: new Date() }]);
    // cm:why the owner IS a member of B, so the token's own allowlist is the only thing left that can refuse — without that row the planted-fence-removal run errors on an exhausted stub instead of answering 200 with `i-b`, and the assertion stops distinguishing a fence from a missing mock
    queueRows([{ orgId: 'org-1', memberRole: 'admin', orgRole: 'owner' }]);
    dbExecute.mockResolvedValueOnce([B_EVENT_ROW]);

    const res = await get(`/api/projects/${PROJECT_B}/metrics/interventions`);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('i-b');
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('still refuses the cross-project fan-out, with projectId and without', async () => {
    tokenScopedTo([PROJECT_A]);

    for (const path of [
      '/api/pipeline/interventions',
      `/api/pipeline/interventions?projectId=${PROJECT_A}`,
    ]) {
      const res = await get(path);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe('PAT_NOT_PERMITTED');
      expect(dbExecute).not.toHaveBeenCalled();
    }
  });
});
