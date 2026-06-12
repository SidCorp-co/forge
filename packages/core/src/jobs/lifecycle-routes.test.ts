import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
const TEST_PEPPER = 'y'.repeat(32);

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

const jobRow = {
  id: 'j1',
  projectId: 'p1',
  deviceId: 'dev-1',
  createdBy: 'u-1',
  issueId: null,
  type: 'plan',
  payload: {},
  modelTier: null,
  status: 'running' as string,
  attempts: 1,
  maxAttempts: 3,
  cancellationRequested: false,
  queuedAt: new Date(),
  dispatchedAt: new Date(),
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  error: null,
  retryOf: null,
  createdAt: new Date(),
};

const verifyDeviceTokenMock = vi.fn(async (token: string) => {
  if (token === 'dev-1-token') {
    return { id: 'dev-1', ownerId: 'u-1', name: 'd1', platform: 'linux' };
  }
  return null;
});
vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: (t: string) => verifyDeviceTokenMock(t),
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

// ISS-442 C0 — cancelJob() runs the status flip + audit insert inside a
// transaction (advisory-lock seq frontier via tx.execute). Mirror the db
// chain on `tx`; `txUpdateReturning` is the cancel path's CAS result.
const txUpdateReturning = vi.fn();
const txUpdateWhere = vi.fn(() => ({ returning: txUpdateReturning }));
const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
const txInsertValues = vi.fn(async () => undefined);
const txExecute = vi.fn(async () => [{ max_seq: 0 }]);
const tx = {
  update: vi.fn(() => ({ set: txUpdateSet })),
  insert: vi.fn(() => ({ values: txInsertValues })),
  execute: txExecute,
};
const dbTransaction = vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect, update: dbUpdate, transaction: dbTransaction },
}));

const scheduleRetryMock = vi.fn(
  async (): Promise<{ scheduled: boolean; newJobId?: string; attempt?: number }> => ({
    scheduled: false,
  }),
);
vi.mock('./retry.js', () => ({
  scheduleAutoRetryWithVerify: (...args: unknown[]) => scheduleRetryMock(...(args as [])),
}));

const publishMock = vi.fn(() => 0);
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishMock },
}));

vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: vi.fn(async () => ({
    projectId: 'p1',
    orgId: 'org-1',
    role: 'admin',
    orgRole: 'owner',
  })),
}));

// ISS-40 PR-E — lifecycle routes now fire-and-forget a per-project tick on
// complete/fail/cancel. Stub it so we don't pull in dispatcher.ts (which
// constructs PgBoss at import time and needs DATABASE_URL).
vi.mock('./dispatch-tick.js', () => ({
  dispatchTickForProject: vi.fn(async () => {}),
}));

// Skip the assertEmailVerified DB call by mocking auth middleware side-effects away
const verifiedUser = { id: 'u-1', emailVerifiedAt: new Date() };
// Our selectLimit is shared — route handler will set its own mocks per test.

const { jobLifecycleDeviceRoutes, jobLifecycleUserRoutes } = await import('./lifecycle-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { signUserToken } = await import('../auth/jwt.js');
const { hooks } = await import('../pipeline/hooks.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/jobs', jobLifecycleDeviceRoutes);
  app.route('/api/jobs', jobLifecycleUserRoutes);
  app.onError(errorHandler);
  return app;
}

function req(path: string, init: RequestInit & { token?: string; deviceToken?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.deviceToken) headers.set('authorization', `Bearer ${init.deviceToken}`);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  const { token: _t, deviceToken: _d, ...rest } = init;
  return new Request(`http://localhost${path}`, { ...rest, headers });
}

const validJobId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  scheduleRetryMock.mockResolvedValue({ scheduled: false });
  selectLimit.mockReset();
  updateReturning.mockReset();
  txUpdateReturning.mockReset();
  txExecute.mockResolvedValue([{ max_seq: 0 }]);
});

describe('POST /:id/complete (device)', () => {
  it('transitions to done on exitCode=0 and does NOT schedule retry', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]); // loadJob
    updateReturning.mockResolvedValueOnce([{ ...jobRow, status: 'done', exitCode: 0 }]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: 0 }),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string; retry: unknown };
    expect(json.status).toBe('done');
    expect(json.retry).toBeNull();
    expect(scheduleRetryMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith(
      'project:p1',
      expect.objectContaining({ event: 'job.completed' }),
    );
  });

  it('transitions to failed on exitCode=1 and schedules retry', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]);
    const updatedRow = { ...jobRow, status: 'failed', exitCode: 1, error: 'crashed' };
    updateReturning.mockResolvedValueOnce([updatedRow]);
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true, newJobId: 'j2', attempt: 2 });

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: 1, error: 'crashed' }),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string; retry: { scheduled: boolean } };
    expect(json.status).toBe('failed');
    expect(json.retry.scheduled).toBe(true);
    expect(publishMock).toHaveBeenCalledWith(
      'project:p1',
      expect.objectContaining({ event: 'job.failed' }),
    );
  });

  it('transitions to cancelled on exitCode=-1', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]);
    updateReturning.mockResolvedValueOnce([{ ...jobRow, status: 'cancelled', exitCode: -1 }]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: -1 }),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string };
    expect(json.status).toBe('cancelled');
    expect(scheduleRetryMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith(
      'project:p1',
      expect.objectContaining({ event: 'job.cancelled' }),
    );
  });

  it('403 when job is dispatched to another device', async () => {
    selectLimit.mockResolvedValueOnce([{ ...jobRow, deviceId: 'dev-other' }]);
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: 0 }),
      }),
    );
    expect(r.status).toBe(403);
  });

  it('409 when job is terminal', async () => {
    selectLimit.mockResolvedValueOnce([{ ...jobRow, status: 'done' }]);
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: 0 }),
      }),
    );
    expect(r.status).toBe(409);
  });
});

describe('POST /:id/complete — idempotent late reconcile (ISS-378)', () => {
  it('reconciles a late success for a server-reaped job (no active retry) → done', async () => {
    const reaped = { ...jobRow, status: 'failed', error: 'session_lost' };
    selectLimit.mockResolvedValueOnce([reaped]); // loadJob
    selectLimit.mockResolvedValueOnce([]); // activeRetry probe → none
    updateReturning.mockResolvedValueOnce([
      { ...reaped, status: 'done', exitCode: 0, error: null },
    ]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: 0 }),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string; reconciled?: boolean };
    expect(json.status).toBe('done');
    expect(json.reconciled).toBe(true);
    expect(scheduleRetryMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith(
      'project:p1',
      expect.objectContaining({ event: 'job.completed' }),
    );
  });

  it('does NOT reconcile when a retry descendant is active → 409', async () => {
    const reaped = { ...jobRow, status: 'failed', error: 'session_lost' };
    selectLimit.mockResolvedValueOnce([reaped]); // loadJob
    selectLimit.mockResolvedValueOnce([{ id: 'retry-1' }]); // activeRetry probe → in flight

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: 0 }),
      }),
    );
    expect(r.status).toBe(409);
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('does NOT reconcile a real failure (non-synthetic error marker) → 409', async () => {
    // A runner /fail (or exitCode≠0 /complete) sets a free-form error, never a
    // synthetic-reap marker — so a later success POST must not silently flip it.
    selectLimit.mockResolvedValueOnce([{ ...jobRow, status: 'failed', error: 'crashed' }]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: 0 }),
      }),
    );
    expect(r.status).toBe(409);
    expect(updateReturning).not.toHaveBeenCalled();
  });
});

describe('POST /:id/fail (device)', () => {
  it('transitions to failed and schedules retry', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]);
    const updatedRow = { ...jobRow, status: 'failed', error: 'segfault' };
    updateReturning.mockResolvedValueOnce([updatedRow]);
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true, newJobId: 'j3', attempt: 2 });

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/fail`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ error: 'segfault' }),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string; retry: { scheduled: boolean } };
    expect(json.status).toBe('failed');
    expect(json.retry.scheduled).toBe(true);
  });
});

describe('POST /:id/cancel (user)', () => {
  async function userToken(userId = 'u-1') {
    return await signUserToken(userId);
  }

  it('cancels a queued job directly (no WS to device)', async () => {
    const queuedJob = { ...jobRow, status: 'queued' as string, deviceId: null };
    selectLimit.mockResolvedValueOnce([verifiedUser]); // assertEmailVerified
    selectLimit.mockResolvedValueOnce([queuedJob]); // loadJob (route authz)
    selectLimit.mockResolvedValueOnce([queuedJob]); // cancelJob internal load
    txUpdateReturning.mockResolvedValueOnce([
      { ...queuedJob, status: 'cancelled', cancellationRequested: true },
    ]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/cancel`, {
        method: 'POST',
        token: await userToken(),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string; cancellationRequested: boolean };
    expect(json.status).toBe('cancelled');
    expect(json.cancellationRequested).toBe(true);
    // No device push for queued cancel
    expect(publishMock).not.toHaveBeenCalledWith('device:dev-1', expect.anything());
    // ISS-442 C0 — exactly one audited intervention row, actor + reason recorded.
    expect(txInsertValues).toHaveBeenCalledTimes(1);
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'intervention',
        data: expect.objectContaining({
          action: 'cancel',
          source: 'rest',
          previousStatus: 'queued',
        }),
      }),
    );
  });

  it('marks cancellationRequested and pushes WS to device on running cancel', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]); // assertEmailVerified
    selectLimit.mockResolvedValueOnce([jobRow]); // loadJob (route authz)
    selectLimit.mockResolvedValueOnce([jobRow]); // cancelJob internal load
    txUpdateReturning.mockResolvedValueOnce([{ ...jobRow, cancellationRequested: true }]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/cancel`, {
        method: 'POST',
        token: await userToken(),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string; cancellationRequested: boolean };
    expect(json.status).toBe('running');
    expect(json.cancellationRequested).toBe(true);
    expect(publishMock).toHaveBeenCalledWith(
      'device:dev-1',
      expect.objectContaining({ event: 'job.cancel' }),
    );
    expect(publishMock).toHaveBeenCalledWith(
      'project:p1',
      expect.objectContaining({ event: 'job.cancelRequested' }),
    );
  });

  it('409 when job is already terminal', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]); // assertEmailVerified
    selectLimit.mockResolvedValueOnce([{ ...jobRow, status: 'done' }]); // loadJob (route authz)
    selectLimit.mockResolvedValueOnce([{ ...jobRow, status: 'done' }]); // cancelJob internal load

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/cancel`, {
        method: 'POST',
        token: await userToken(),
      }),
    );
    expect(r.status).toBe(409);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('NOT_CANCELLABLE');
  });
});

// ISS-20 — hook emits feed PM spawn triggers. Cancelled lifecycle does not
// emit; failed must include `failureKind` (set by scheduleRetry).
describe('jobFailed / jobCompleted hook emits', () => {
  const failedSpy = vi.fn();
  const completedSpy = vi.fn();

  beforeEach(() => {
    hooks.reset();
    failedSpy.mockReset();
    completedSpy.mockReset();
    hooks.on('jobFailed', (p) => failedSpy(p));
    hooks.on('jobCompleted', (p) => completedSpy(p));
  });

  it('emits jobCompleted exactly once on exitCode=0, never jobFailed', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]);
    updateReturning.mockResolvedValueOnce([{ ...jobRow, status: 'done', exitCode: 0 }]);
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: 0 }),
      }),
    );
    expect(r.status).toBe(200);
    expect(completedSpy).toHaveBeenCalledTimes(1);
    expect(completedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', projectId: 'p1', type: 'plan' }),
    );
    expect(failedSpy).not.toHaveBeenCalled();
  });

  it('emits jobFailed with failureKind on exitCode=1', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]);
    updateReturning.mockResolvedValueOnce([
      {
        ...jobRow,
        status: 'failed',
        exitCode: 1,
        error: 'crashed',
        failureKind: 'transient',
        failureReason: 'classified',
      },
    ]);
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true });
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: 1, error: 'crashed' }),
      }),
    );
    expect(r.status).toBe(200);
    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(failedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: 'transient', failureReason: 'classified' }),
    );
    expect(completedSpy).not.toHaveBeenCalled();
  });

  it('emits neither on exitCode=-1 (cancelled)', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]);
    updateReturning.mockResolvedValueOnce([{ ...jobRow, status: 'cancelled', exitCode: -1 }]);
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/complete`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ exitCode: -1 }),
      }),
    );
    expect(r.status).toBe(200);
    expect(failedSpy).not.toHaveBeenCalled();
    expect(completedSpy).not.toHaveBeenCalled();
  });

  it('POST /:id/fail emits jobFailed with classified failureKind', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]);
    updateReturning.mockResolvedValueOnce([
      {
        ...jobRow,
        status: 'failed',
        error: 'segfault',
        failureKind: 'unknown',
        failureReason: 'unmapped',
      },
    ]);
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false });
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/fail`, {
        method: 'POST',
        deviceToken: 'dev-1-token',
        body: JSON.stringify({ error: 'segfault' }),
      }),
    );
    expect(r.status).toBe(200);
    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(failedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: 'unknown', failureReason: 'unmapped' }),
    );
  });
});
