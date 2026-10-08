/**
 * `POST /:projectId/release-batches/:runId/readings` — the HTTP half of a look (ISS-1282).
 *
 * `look.test.ts` owns what is read and judged; this owns who may ask and how each refusal is
 * answered, under the codes the finish already gives the ones they share.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' },
}));

const selectLimit = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) })) },
}));

const lookMock = vi.fn();
vi.mock('./look.js', () => ({ lookAtBatch: (a: unknown) => lookMock(a) }));

const findRunMock = vi.fn();
vi.mock('./service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./service.js')>()),
  findReleaseBatchRun: (a: unknown) => findRunMock(a),
}));

const loadAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => loadAccess(...args),
}));

const { releaseBatchRoutes } = await import('./routes.js');
const errors = await import('./errors.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const NEW = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', releaseBatchRoutes);
  app.onError(errorHandler);
  return app;
}

async function post(body: unknown) {
  return await buildApp().request(
    `/api/projects/${PROJECT_ID}/release-batches/${RUN_ID}/readings`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await signUserToken(USER_ID)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

async function lookReq(body: unknown = {}) {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
  loadAccess.mockResolvedValueOnce({
    projectId: PROJECT_ID,
    orgId: 'org-1',
    role: 'member',
    orgRole: 'member',
  });
  findRunMock.mockResolvedValueOnce({ id: RUN_ID, projectId: PROJECT_ID });
  return await post(body);
}

// `mockReset`, not `clearAllMocks`: a refusal that fires before the handler leaves its queued
// answers unconsumed, and the next case would meet them.
beforeEach(() => {
  for (const mock of [selectLimit, lookMock, findRunMock, loadAccess]) mock.mockReset();
});

describe('POST .../readings — the agent asks Forge to look', () => {
  it('answers 201 with what was stored and what a finish would make of it, for the caller who asked', async () => {
    const answer = {
      reading: { id: 'reading-1', bindings: [], unread: [] },
      judgement: { closable: true, moved: true, evidence: ['reading-1'] },
    };
    lookMock.mockResolvedValueOnce(answer);

    const res = await lookReq({ commit: NEW });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(answer);
    expect(lookMock).toHaveBeenCalledWith({ runId: RUN_ID, takenBy: USER_ID, commit: NEW });
  });

  it('takes a look naming no commit', async () => {
    lookMock.mockResolvedValueOnce({});

    const res = await lookReq();

    expect(res.status).toBe(201);
    expect(lookMock).toHaveBeenCalledWith({ runId: RUN_ID, takenBy: USER_ID });
  });

  it('refuses a body carrying a key it does not take, rather than ignoring it', async () => {
    const res = await lookReq({ commit: NEW, identity: NEW });

    expect(res.status).toBe(400);
    expect(lookMock).not.toHaveBeenCalled();
  });

  it('answers 404 to a caller with no role on the project, before anything is read', async () => {
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    loadAccess.mockResolvedValueOnce(null);
    findRunMock.mockResolvedValueOnce({ id: RUN_ID, projectId: PROJECT_ID });

    const res = await post({});

    expect(res.status).toBe(404);
    expect(lookMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a run this project does not own, before reading anything', async () => {
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    findRunMock.mockResolvedValueOnce({ id: RUN_ID, projectId: 'another-project' });

    const res = await post({});

    expect(res.status).toBe(404);
    expect(lookMock).not.toHaveBeenCalled();
  });
});

describe('POST .../readings — every refusal under its own code', () => {
  async function refusedWith(err: Error, body: unknown = {}) {
    lookMock.mockRejectedValueOnce(err);
    const res = await lookReq(body);
    return { status: res.status, body: (await res.json()) as { code?: string; message?: string } };
  }

  it('answers 409 RELEASE_NOTHING_TO_READ where no binding declares a probe', async () => {
    const { status, body } = await refusedWith(new errors.ReleaseNothingToReadError());

    expect(status).toBe(409);
    expect(body.code).toBe('RELEASE_NOTHING_TO_READ');
    expect(body.message).toContain('finish records this release as unverified');
  });

  it('answers 409 RELEASE_RUN_CLOSED for a batch whose run is over', async () => {
    const { status, body } = await refusedWith(new errors.ReleaseRunClosedError('completed'));

    expect(status).toBe(409);
    expect(body.code).toBe('RELEASE_RUN_CLOSED');
    expect(body.message).toContain('completed');
  });

  it('answers 409 RELEASE_BATCH_ABORTED for an aborted batch, as the finish does', async () => {
    const { status, body } = await refusedWith(
      new errors.ReleaseBatchAbortedError('released', 'p-1'),
    );

    expect(status).toBe(409);
    expect(body.code).toBe('RELEASE_BATCH_ABORTED');
  });

  it('answers 409 RELEASE_PROBES_UNREADABLE naming the binding whose declaration Forge cannot read', async () => {
    const { status, body } = await refusedWith(
      new errors.ReleaseProbesUnreadableError([], ['coolify b-1']),
    );

    expect(status).toBe(409);
    expect(body.code).toBe('RELEASE_PROBES_UNREADABLE');
    expect(JSON.stringify(body)).toContain('coolify b-1');
  });

  it('answers 409 RELEASE_NOT_VERIFIED for a commit that is not a whole sha', async () => {
    const { status, body } = await refusedWith(
      new errors.ReleaseNotVerifiedError('`abc` is not a whole commit', null),
      { commit: 'abc' },
    );

    expect(status).toBe(409);
    expect(body.code).toBe('RELEASE_NOT_VERIFIED');
    expect(body.message).toBe('`abc` is not a whole commit');
  });

  it('passes an error it does not know through as a 500 rather than a 409', async () => {
    const { status } = await refusedWith(new Error('connection terminated unexpectedly'));

    expect(status).toBe(500);
  });
});
