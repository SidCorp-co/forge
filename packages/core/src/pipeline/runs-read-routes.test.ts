/**
 * ISS-103 — REST surface tests for the read-side pipeline_runs handlers.
 * Auth gating, 404 translation, and the X-Total-Count envelope are covered
 * here; the rollup query shapes are unit-tested in `runs-rollup.test.ts`.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectOffset = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: () => ({ offset: selectOffset }) }));

// `.where()` may be awaited directly (count query) OR chained via
// `.orderBy().limit().offset()` (list) OR `.limit(1)` (single-row read).
// The returned chimera carries `.orderBy`, `.limit`, and `.then` so all
// call sites resolve without needing to know in advance which one was
// used. `whereThenableValues` is consumed only when `.then()` is invoked
// (i.e. the where is awaited directly — count case).
const whereThenableValues: unknown[] = [];

function selectWhere(): unknown {
  return {
    orderBy: selectOrderBy,
    limit: selectLimit,
    then: (
      onFulfilled: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) =>
      Promise.resolve(whereThenableValues.shift() ?? []).then(
        onFulfilled,
        onRejected,
      ),
  };
}

// loadProjectAccess (lib/authz) runs select().from().leftJoin().leftJoin()
// .where().limit() — route the join chain back into the same where/limit FIFO.
const selectLeftJoin = vi.fn((): Record<string, unknown> => ({
  leftJoin: selectLeftJoin,
  where: selectWhere,
}));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));

function setupSelectChain() {
  whereThenableValues.length = 0;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const loadSummarySpy = vi.fn();
const listItemsSpy = vi.fn();

vi.mock('./runs-rollup.js', () => ({
  loadPipelineRunSummary: (id: string) => loadSummarySpy(id),
  listItemsFromRows: (rows: unknown[]) => listItemsSpy(rows),
}));

const {
  pipelineRunReadRoutes,
  pipelineRunProjectRoutes,
} = await import('./runs-read-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/pipeline-runs', pipelineRunReadRoutes);
  app.route('/api/projects', pipelineRunProjectRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function runProjectFound() {
  selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
}

function runProjectMissing() {
  selectLimit.mockResolvedValueOnce([]);
}

function projectAccessAsMember() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

function projectAccessAsNonMember() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
}

async function token() {
  return signUserToken(USER_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectOffset.mockReset();
  loadSummarySpy.mockReset();
  listItemsSpy.mockReset();
  setupSelectChain();
});

describe('GET /api/pipeline-runs/:id', () => {
  it('returns 200 with the rolled-up summary when caller is a member', async () => {
    authVerified();
    runProjectFound();
    projectAccessAsMember();
    loadSummarySpy.mockResolvedValueOnce({
      id: RUN_ID,
      projectId: PROJECT_ID,
      issueId: null,
      kind: 'issue',
      status: 'running',
      currentStep: 'code',
      startedAt: '2026-05-12T00:00:00.000Z',
      finishedAt: null,
      steps: [],
      cost: {
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requests: 0,
        sampleCount: 0,
      },
    });

    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(RUN_ID);
    expect(body.status).toBe('running');
    expect(loadSummarySpy).toHaveBeenCalledWith(RUN_ID);
  });

  it('returns 404 when the run is missing', async () => {
    authVerified();
    runProjectMissing();

    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
    expect(loadSummarySpy).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is not a project member', async () => {
    authVerified();
    runProjectFound();
    projectAccessAsNonMember();

    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
    expect(loadSummarySpy).not.toHaveBeenCalled();
  });

  it('returns 400 on a non-uuid param', async () => {
    authVerified();
    const res = await buildApp().request('/api/pipeline-runs/not-a-uuid', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/projects/:id/pipeline-runs', () => {
  it('returns 200 with X-Total-Count + list items', async () => {
    authVerified();
    projectAccessAsMember();
    // count() row — `.where()` is awaited directly.
    whereThenableValues.push([{ n: 7 }]);
    selectOffset.mockResolvedValueOnce([
      { id: RUN_ID, projectId: PROJECT_ID, kind: 'issue', status: 'running' },
    ]);
    listItemsSpy.mockResolvedValueOnce([
      {
        id: RUN_ID,
        projectId: PROJECT_ID,
        issueId: null,
        kind: 'issue',
        status: 'running',
        currentStep: null,
        startedAt: '2026-05-12T00:00:00.000Z',
        finishedAt: null,
        cost: {
          estimatedCost: 1.23,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          requests: 0,
          sampleCount: 1,
        },
      },
    ]);

    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/pipeline-runs?limit=10&offset=0`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBe('7');
    const body = (await res.json()) as Array<{ id: string; cost: { estimatedCost: number } }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.cost.estimatedCost).toBe(1.23);
  });

  it('returns 403 when caller is not a project member', async () => {
    authVerified();
    projectAccessAsNonMember();

    const res = await buildApp().request(`/api/projects/${PROJECT_ID}/pipeline-runs`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
    expect(listItemsSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid status filter with 400', async () => {
    authVerified();
    const res = await buildApp().request(
      `/api/projects/${PROJECT_ID}/pipeline-runs?status=bogus`,
      { headers: { authorization: `Bearer ${await token()}` } },
    );
    expect(res.status).toBe(400);
  });
});
