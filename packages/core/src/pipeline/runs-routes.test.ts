/**
 * ISS-102 — REST surface tests for `/api/pipeline-runs/:id/{pause,resume,cancel}`.
 * The transition helpers themselves are exercised in `runs-control.test.ts`;
 * these tests cover auth gating, error translation, and response shape.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
// loadProjectAccess (lib/authz) runs select().from().leftJoin().leftJoin()
// .where().limit() — route the join chain back into the same where/limit FIFO.
const selectLeftJoin = vi.fn((): Record<string, unknown> => ({
  leftJoin: selectLeftJoin,
  where: selectWhere,
}));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const pauseSpy = vi.fn();
const resumeSpy = vi.fn();
const cancelSpy = vi.fn();

vi.mock('./runs-control.js', () => ({
  pausePipelineRun: (id: string) => pauseSpy(id),
  resumePipelineRun: (id: string) => resumeSpy(id),
  cancelPipelineRun: (id: string) => cancelSpy(id),
}));

const { pipelineRunRoutes } = await import('./runs-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/pipeline-runs', pipelineRunRoutes);
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

function runFound(status = 'running') {
  selectLimit.mockResolvedValueOnce([
    {
      id: RUN_ID,
      projectId: PROJECT_ID,
      issueId: null,
      kind: 'issue',
      status,
      currentStep: null,
      startedAt: new Date(),
      finishedAt: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
}

function projectAccessAsMember() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

function projectAccessAsOwner() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: 'owner' }]);
}

function projectAccessAsNonMember() {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
}

async function token(userId = USER_ID) {
  return signUserToken(userId);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  pauseSpy.mockReset();
  resumeSpy.mockReset();
  cancelSpy.mockReset();
});

describe('POST /api/pipeline-runs/:id/pause', () => {
  it('returns 200 with the updated run when caller is a member', async () => {
    authVerified();
    runFound('running');
    projectAccessAsMember();
    pauseSpy.mockResolvedValueOnce({ id: RUN_ID, status: 'paused' });

    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}/pause`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('paused');
    expect(pauseSpy).toHaveBeenCalledWith(RUN_ID);
  });

  it('returns 404 when the run is missing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]); // run lookup empty

    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}/pause`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is not a project member', async () => {
    authVerified();
    runFound('running');
    projectAccessAsNonMember();

    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}/pause`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('returns 400 on a non-uuid param', async () => {
    authVerified();

    const res = await buildApp().request('/api/pipeline-runs/not-a-uuid/pause', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/pipeline-runs/:id/resume', () => {
  it('returns 200 with the resumed run', async () => {
    authVerified();
    runFound('paused');
    projectAccessAsOwner();
    resumeSpy.mockResolvedValueOnce({ id: RUN_ID, status: 'running' });

    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}/resume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('running');
    expect(resumeSpy).toHaveBeenCalledWith(RUN_ID);
  });

  it('translates CONFLICT from the helper into a 409 with cause.code=run_terminal', async () => {
    authVerified();
    runFound('completed');
    projectAccessAsOwner();
    resumeSpy.mockRejectedValueOnce(new Error('CONFLICT: run already completed'));

    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}/resume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/pipeline-runs/:id/cancel', () => {
  it('returns 200 with the side-effect summary', async () => {
    authVerified();
    runFound('running');
    projectAccessAsOwner();
    cancelSpy.mockResolvedValueOnce({
      run: { id: RUN_ID, status: 'cancelled' },
      cancelledJobIds: ['job-1', 'job-2'],
      abortedSessionIds: ['sess-1'],
      deviceIdsNotified: ['dev-A'],
    });

    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { status: string };
      cancelledJobIds: string[];
      abortedSessionIds: string[];
    };
    expect(body.run.status).toBe('cancelled');
    expect(body.cancelledJobIds).toHaveLength(2);
    expect(body.abortedSessionIds).toEqual(['sess-1']);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const res = await buildApp().request(`/api/pipeline-runs/${RUN_ID}/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});
