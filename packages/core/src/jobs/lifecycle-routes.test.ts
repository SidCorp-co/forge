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
  killRequestedAt: new Date() as Date | null,
  killConfirmedAt: null,
  killOutcome: null,
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
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

// ISS-447 — the /complete, /fail and late-reclaim job flips now route through
// applyKernelTransition(db, …), which writes the kernel_transitions audit row
// on the same db handle right after the status UPDATE.
const dbInsertValues = vi.fn(async () => undefined);
const dbInsert = vi.fn(() => ({ values: dbInsertValues }));

// ISS-442 C0 — cancelJob() runs the status flip + audit insert inside a
// transaction (advisory-lock seq frontier via tx.execute). Mirror the db
// chain on `tx`; `txUpdateReturning` is the cancel path's CAS result.
const txUpdateReturning = vi.fn();
const txUpdateWhere = vi.fn(() => ({ returning: txUpdateReturning }));
const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
// The intervention (job_events) insert passes a single object; ISS-447's
// kernel_transitions audit insert passes an array of rows. Route them to
// separate spies so the "exactly one intervention" assertion stays precise.
const txInsertValues = vi.fn(async (_v?: unknown) => undefined);
const txAuditValues = vi.fn(async (_v?: unknown) => undefined);
const txExecute = vi.fn(async () => [{ max_seq: 0 }]);
const tx = {
  update: vi.fn(() => ({ set: txUpdateSet })),
  insert: vi.fn(() => ({
    values: (v: unknown) => (Array.isArray(v) ? txAuditValues(v) : txInsertValues(v)),
  })),
  execute: txExecute,
};
const dbTransaction = vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect, update: dbUpdate, insert: dbInsert, transaction: dbTransaction },
}));

const scheduleRetryMock = vi.fn(
  async (): Promise<{ scheduled: boolean; newJobId?: string; attempt?: number }> => ({
    scheduled: false,
  }),
);
// cm:edge contract -> packages/core/src/jobs/retry.ts — the literal MUST equal AUTO_RETRY_PAYLOAD_KEY there; hold.ts (reached via the resume route) imports the real constant, and omitting it here made `buildRequeueUpdate` strip a key named "undefined" instead of the spent rotation
vi.mock('./retry.js', () => ({
  AUTO_RETRY_PAYLOAD_KEY: '_autoRetry',
  scheduleAutoRetryWithVerify: (...args: unknown[]) => scheduleRetryMock(...(args as [])),
}));

const enqueueMock = vi.fn(async () => {});
vi.mock('./enqueue.js', () => ({
  enqueueJob: () => enqueueMock(),
  enqueueReconcileJob: () => enqueueMock(),
}));

vi.mock('../pipeline/wedge.js', () => ({
  emitPipelineWedge: async () => undefined,
  resolvePipelineWedge: async () => 0,
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
  selectOrderBy.mockImplementation(() => ({ limit: selectLimit }));
  updateReturning.mockReset();
  txUpdateReturning.mockReset();
  txExecute.mockResolvedValue([{ max_seq: 0 }]);
});

function postAsDevice(verb: string, body: unknown, deviceToken = 'dev-1-token') {
  return buildApp().fetch(
    req(`/api/jobs/${validJobId}/${verb}`, {
      method: 'POST',
      deviceToken,
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /:id/ack (device) — job.ran.with (ISS-798 fix)', () => {
  it('the first ack ends any open kill episode — the columns are cleared with the same CAS (ISS-785 review round 2)', async () => {
    selectLimit.mockResolvedValueOnce([
      {
        ...jobRow,
        killRequestedAt: new Date(),
        killConfirmedAt: new Date(),
        killOutcome: 'not_found',
      },
    ]);
    txUpdateReturning.mockResolvedValueOnce([
      { id: jobRow.id, status: jobRow.status, ackedAt: new Date() },
    ]);

    const r = await postAsDevice('ack', {});

    expect(r.status).toBe(200);
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        ackedAt: expect.any(Date),
        killRequestedAt: null,
        killConfirmedAt: null,
        killOutcome: null,
      }),
    );
  });

  it('records job.ran.with with the resolved skillId + packetId when the runner ACKs with a non-empty skillsRanWith map', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]); // loadJob
    selectLimit.mockResolvedValueOnce([{ id: 'skill-1' }]);
    selectLimit.mockResolvedValueOnce([{ packetId: 'packet-1' }]);
    txUpdateReturning.mockResolvedValueOnce([
      { id: jobRow.id, status: jobRow.status, ackedAt: new Date() },
    ]);

    const r = await postAsDevice('ack', { skillsRanWith: { 'forge-code': 'hash-abc' } });
    expect(r.status).toBe(200);
    const json = (await r.json()) as { acked: boolean };
    expect(json.acked).toBe(true);
    expect(txInsertValues).toHaveBeenCalledTimes(1);
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.ran.with',
        actor: 'runner:dev-1',
        projectId: 'p1',
        deviceId: 'dev-1',
        skillId: 'skill-1',
        packetId: 'packet-1',
        afterHash: 'hash-abc',
        reason: `jobId=${validJobId}`,
        deltaSummary: 'forge-code',
      }),
    );
  });

  it('records job.ran.with with no skillId/packetId when the name does not resolve to a registered skill', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]); // loadJob
    selectLimit.mockResolvedValueOnce([]);
    txUpdateReturning.mockResolvedValueOnce([
      { id: jobRow.id, status: jobRow.status, ackedAt: new Date() },
    ]);

    const r = await postAsDevice('ack', { skillsRanWith: { 'unregistered-skill': 'hash-xyz' } });
    expect(r.status).toBe(200);
    expect(txInsertValues).toHaveBeenCalledTimes(1);
    const [call] = txInsertValues.mock.calls[0] as [Record<string, unknown>];
    expect(call.skillId).toBeNull();
    expect(call.packetId).toBeNull();
    expect(call.afterHash).toBe('hash-xyz');
  });

  it('records nothing when skillsRanWith is absent (pre-0.7.0 runner)', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]); // loadJob
    txUpdateReturning.mockResolvedValueOnce([
      { id: jobRow.id, status: jobRow.status, ackedAt: new Date() },
    ]);

    const r = await postAsDevice('ack', {});
    expect(r.status).toBe(200);
    expect(txInsertValues).not.toHaveBeenCalled();
  });

  it('records nothing when skillsRanWith is an empty map', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]); // loadJob
    txUpdateReturning.mockResolvedValueOnce([
      { id: jobRow.id, status: jobRow.status, ackedAt: new Date() },
    ]);

    const r = await postAsDevice('ack', { skillsRanWith: {} });
    expect(r.status).toBe(200);
    expect(txInsertValues).not.toHaveBeenCalled();
  });
});

describe('POST /:id/complete (device)', () => {
  it('transitions to done on exitCode=0 and does NOT schedule retry', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]); // loadJob
    updateReturning.mockResolvedValueOnce([{ ...jobRow, status: 'done', exitCode: 0 }]);

    const r = await postAsDevice('complete', { exitCode: 0 });
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

    const r = await postAsDevice('complete', { exitCode: 1, error: 'crashed' });
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

    const r = await postAsDevice('complete', { exitCode: -1 });
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
    const r = await postAsDevice('complete', { exitCode: 0 });
    expect(r.status).toBe(403);
  });

  it('409 when job is terminal', async () => {
    selectLimit.mockResolvedValueOnce([{ ...jobRow, status: 'done' }]);
    const r = await postAsDevice('complete', { exitCode: 0 });
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

    const r = await postAsDevice('complete', { exitCode: 0 });
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

    const r = await postAsDevice('complete', { exitCode: 0 });
    expect(r.status).toBe(409);
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('does NOT reconcile a real failure (non-synthetic error marker) → 409', async () => {
    // A runner /fail (or exitCode≠0 /complete) sets a free-form error, never a
    // synthetic-reap marker — so a later success POST must not silently flip it.
    selectLimit.mockResolvedValueOnce([{ ...jobRow, status: 'failed', error: 'crashed' }]);

    const r = await postAsDevice('complete', { exitCode: 0 });
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

    const r = await postAsDevice('fail', { error: 'segfault' });
    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string; retry: { scheduled: boolean } };
    expect(json.status).toBe('failed');
    expect(json.retry.scheduled).toBe(true);
  });
});

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/workspace/salvage.rs — this body is what `Salvage::to_json` emits, field for field. `failBodySchema` is `.strict()`, so drift on either side is a 400 that discards the WHOLE failure report rather than only the salvage; reading both files is not the same as exercising the boundary, which is why this test posts the literal shape.
describe('POST /:id/fail — salvage (ISS-862 L1)', () => {
  function failWith(body: Record<string, unknown>) {
    selectLimit.mockResolvedValueOnce([jobRow]);
    updateReturning.mockResolvedValueOnce([{ ...jobRow, status: 'failed' }]);
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false });
    return postAsDevice('fail', body);
  }

  // cm:guard find the update that CARRIES failureMeta rather than reading `.at(-1)` — the fail route is no longer the last writer on this mock: the kernel chokepoint now also revokes the job's token, whose own `.set()` lands after it. `.at(-1)` read that one and reported the route had written nothing, which is a test that breaks on an unrelated write instead of on its own rule.
  function lastFailureMeta() {
    for (const args of [...updateSet.mock.calls].reverse() as unknown[][]) {
      const set = args[0] as Record<string, unknown> | undefined;
      if (set && 'failureMeta' in set) return set.failureMeta;
    }
    return undefined;
  }

  it('accepts the exact object the runner emits and merges it into failure_meta', async () => {
    const salvage = {
      outcome: 'pushed',
      branch: 'ISS-862-runner-health',
      sha: 'a1b2c3d',
      files: 7,
      insertions: 214,
    };
    expect((await failWith({ error: 'boom', salvage })).status).toBe(200);
    expect(lastFailureMeta()).toBeDefined();
  });

  it('still records the failure when the runner reports no salvage at all', async () => {
    expect((await failWith({ error: 'boom' })).status).toBe(200);
    expect(lastFailureMeta()).toBeUndefined();
  });

  it.each([
    ['a field neither side declared', { outcome: 'pushed', worktree: '/repo/.claude/wt' }],
    ['an outcome the renderer cannot render', { outcome: 'partially_pushed' }],
  ])('rejects %s rather than dropping it silently', async (_name, salvage) => {
    expect((await failWith({ error: 'boom', salvage })).status).toBe(400);
  });
});

describe('POST /:id/kill-ack (device) — ISS-785', () => {
  it('device-scoped: 403s a kill-ack from a device the job is not dispatched to', async () => {
    selectLimit.mockResolvedValueOnce([{ ...jobRow, deviceId: 'someone-else' }]);

    const r = await postAsDevice('kill-ack', { outcome: 'killed' });

    expect(r.status).toBe(403);
    expect(txInsertValues).not.toHaveBeenCalled();
  });

  it('stamps killConfirmedAt/killOutcome and writes a kill_ack job_event', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]);

    const r = await postAsDevice('kill-ack', { outcome: 'killed' });

    expect(r.status).toBe(200);
    const json = (await r.json()) as {
      jobId: string;
      killOutcome: string;
      acked: boolean;
      recorded: boolean;
    };
    expect(json).toEqual({
      jobId: validJobId,
      killOutcome: 'killed',
      acked: true,
      recorded: true,
    });
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ killConfirmedAt: expect.any(Date), killOutcome: 'killed' }),
    );
    expect(txInsertValues).toHaveBeenCalledTimes(1);
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: validJobId,
        kind: 'kill_ack',
        data: { outcome: 'killed', deviceId: 'dev-1', recorded: true },
      }),
    );
  });

  it('audits but does NOT stamp an ack for a job with no kill requested (ISS-785 review round 2)', async () => {
    selectLimit.mockResolvedValueOnce([{ ...jobRow, killRequestedAt: null }]);

    const r = await postAsDevice('kill-ack', { outcome: 'not_found' });

    expect(r.status).toBe(200);
    expect((await r.json()) as { recorded: boolean }).toMatchObject({ recorded: false });
    expect(txUpdateSet).not.toHaveBeenCalled();
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { outcome: 'not_found', deviceId: 'dev-1', recorded: false },
      }),
    );
  });

  it('reports not_found (the important value — no process ever existed to kill)', async () => {
    selectLimit.mockResolvedValueOnce([jobRow]);

    const r = await postAsDevice('kill-ack', { outcome: 'not_found' });

    expect(r.status).toBe(200);
    const json = (await r.json()) as { killOutcome: string };
    expect(json.killOutcome).toBe('not_found');
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { outcome: 'not_found', deviceId: 'dev-1', recorded: true },
      }),
    );
  });

  it('is idempotent and returns 200 even when the job is already terminal', async () => {
    selectLimit.mockResolvedValueOnce([{ ...jobRow, status: 'failed' }]);

    const r = await postAsDevice('kill-ack', { outcome: 'killed' });

    expect(r.status).toBe(200);
    // cm:guard first-ack-wins is enforced by the UPDATE's WHERE (killConfirmedAt IS NULL) — the route must never reject a terminal job, the ack is evidence not a transition
    expect(txInsertValues).toHaveBeenCalledTimes(1);
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

describe('POST /:id/resume (user)', () => {
  const heldJob = {
    ...jobRow,
    status: 'held' as string,
    deviceId: null,
    failureReason: 'non_retryable_terminal',
    payload: {
      __hold: {
        reason: 'non_retryable_terminal',
        heldAt: '2026-08-14T06:00:00.000Z',
        autoRelease: false,
      },
    },
  };

  // cm:guard three queued `selectLimit` results in this exact order — assertEmailVerified, the route's own authz load, then the service's re-read. Drop one and the service reads the USER row as its job, which fails on a status mismatch and looks like a route bug.
  it('re-queues a held job and audits it as a resume, not a cancel', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    selectLimit.mockResolvedValueOnce([heldJob]);
    selectLimit.mockResolvedValueOnce([heldJob]);
    txUpdateReturning.mockResolvedValueOnce([{ id: 'j1', type: 'plan', issueId: 'i1' }]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/resume`, {
        method: 'POST',
        token: await signUserToken('u-1'),
        body: JSON.stringify({ reason: 'workspace re-provisioned' }),
      }),
    );

    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string; heldReason: string };
    expect(json.status).toBe('queued');
    expect(json.heldReason).toBe('non_retryable_terminal');
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'intervention',
        data: expect.objectContaining({
          action: 'resume',
          source: 'rest',
          previousStatus: 'held',
          reason: 'workspace re-provisioned',
        }),
      }),
    );
  });

  // cm:guard 409 NOT_HELD, never 200 — a resume that reports success for a job it did not move is the state-lies failure `VISION: state-never-lies` forbids, and the operator would stop looking for the stuck step
  it('409 NOT_HELD when the job is in any other status', async () => {
    selectLimit.mockResolvedValueOnce([verifiedUser]);
    selectLimit.mockResolvedValueOnce([jobRow]);
    selectLimit.mockResolvedValueOnce([jobRow]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/resume`, { method: 'POST', token: await signUserToken('u-1') }),
    );

    expect(r.status).toBe(409);
    expect(((await r.json()) as { code?: string }).code).toBe('NOT_HELD');
    expect(txInsertValues).not.toHaveBeenCalled();
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
    const r = await postAsDevice('complete', { exitCode: 0 });
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
    const r = await postAsDevice('complete', { exitCode: 1, error: 'crashed' });
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
    const r = await postAsDevice('complete', { exitCode: -1 });
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
    const r = await postAsDevice('fail', { error: 'segfault' });
    expect(r.status).toBe(200);
    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(failedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: 'unknown', failureReason: 'unmapped' }),
    );
  });
});
