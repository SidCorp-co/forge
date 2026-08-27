import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: () => ({ limit: () => ({ offset: vi.fn() }) }),
  groupBy: () => ({ then: (cb: (v: unknown) => unknown) => Promise.resolve([]).then(cb) }),
  then: (cb: (v: unknown) => unknown) => Promise.resolve([]).then(cb),
}));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_set: unknown) => ({ where: updateWhere }));

vi.mock('../db/client.js', () => {
  const dbStub = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    execute: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbStub)),
  };
  return { db: dbStub };
});

vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));

const verifyDeviceTokenMock = vi.fn(async (_token: unknown) => null as { id: string } | null);
vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: (token: unknown) => verifyDeviceTokenMock(token),
}));

vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: vi.fn(async () => null),
  resolveRepoPath: () => null,
}));

vi.mock('../pipeline/activity.js', () => ({ safeRecordActivity: vi.fn(async () => {}) }));

vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn(async () => ({ id: 'run-1', startedAt: new Date() })),
  openOneShotRun: vi.fn(async () => ({ id: 'run-1' })),
  closeRun: vi.fn(async () => undefined),
  closeRunIfOneShot: vi.fn(async () => undefined),
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStep: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

const projectAccessMock = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccessMock(...args),
  loadVisibleProjectIds: vi.fn(async () => [] as string[]),
}));

vi.mock('../integrations/rocketchat/escalation-bridge.js', () => ({
  deliverEscalationReplyOnce: vi.fn(async () => undefined),
}));

vi.mock('../runners/apply-runner-limit.js', () => ({
  stampRunnerLimit: vi.fn(async () => undefined),
  clearRunnerLimit: vi.fn(async () => undefined),
}));

const { isBlindScheduleRun, BLIND_SCHEDULE_RUN_REASON } = await import('./schedule-evidence.js');
const { agentSessionRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const SCHEDULE_ID = '55555555-5555-4555-8555-555555555555';

const SCHEDULE_META = { source: 'schedule.run', scheduleId: SCHEDULE_ID };

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/agent-sessions', agentSessionRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectLimit.mockResolvedValue([]);
  updateReturning.mockReset();
  projectAccessMock.mockReset();
  verifyDeviceTokenMock.mockReset();
  verifyDeviceTokenMock.mockResolvedValue(null);
});

/** Seed the session row the PATCH handler loads, then its post-write return. */
function seedSession(metadata: Record<string, unknown> | null) {
  selectLimit.mockResolvedValueOnce([
    {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
      status: 'running',
      messages: [],
      metadata,
      failureReason: null,
    },
  ]);
}

async function patchAsDevice(body: Record<string, unknown>) {
  verifyDeviceTokenMock.mockResolvedValueOnce({ id: DEVICE_ID });
  return buildApp().request(`/api/agent-sessions/${SESSION_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer device-token-xyz' },
    body: JSON.stringify(body),
  });
}

function persistedUpdate() {
  return updateSet.mock.calls[0]?.[0] as {
    status?: string;
    failureReason?: string;
    metadata?: Record<string, unknown>;
  };
}

describe('isBlindScheduleRun', () => {
  const base = {
    resolvedStatus: 'completed' as const,
    metadata: SCHEDULE_META as Record<string, unknown>,
    toolCallCount: 0 as number | undefined,
    principal: 'device' as string | undefined,
  };

  it('is blind when a device reports a completed schedule run that called no tool', () => {
    expect(isBlindScheduleRun(base)).toBe(true);
  });

  it('is not blind when the runner never reported a count', () => {
    expect(isBlindScheduleRun({ ...base, toolCallCount: undefined })).toBe(false);
  });

  it('is not blind when the run called at least one tool', () => {
    expect(isBlindScheduleRun({ ...base, toolCallCount: 1 })).toBe(false);
  });

  it('is not blind for an interactive chat session that happens to call nothing', () => {
    expect(isBlindScheduleRun({ ...base, metadata: { agentChat: true } })).toBe(false);
    expect(isBlindScheduleRun({ ...base, metadata: null })).toBe(false);
  });

  it('is not blind when the resolved status is already failed', () => {
    expect(isBlindScheduleRun({ ...base, resolvedStatus: 'failed' })).toBe(false);
  });

  it('ignores a count asserted by a non-device principal', () => {
    expect(isBlindScheduleRun({ ...base, principal: 'user' })).toBe(false);
    expect(isBlindScheduleRun({ ...base, principal: undefined })).toBe(false);
  });
});

describe('PATCH /api/agent-sessions/:id — ISS-859: a scheduled run that read nothing', () => {
  it('persists failed/audit_ran_blind instead of the reported completed', async () => {
    seedSession(SCHEDULE_META);
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'failed',
        metadata: {},
      },
    ]);

    const res = await patchAsDevice({
      status: 'completed',
      toolCallCount: 0,
      messages: [{ type: 'assistant', content: 'Backlog reviewed: 47 non-closed issues.' }],
    });

    expect(res.status).toBe(200);
    expect(persistedUpdate().status).toBe('failed');
    expect(persistedUpdate().failureReason).toBe(BLIND_SCHEDULE_RUN_REASON);
  });

  it("leaves the schedule's lastStatus reading failed, not success", async () => {
    seedSession(SCHEDULE_META);
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'failed',
        metadata: SCHEDULE_META,
      },
    ]);

    await patchAsDevice({ status: 'completed', toolCallCount: 0 });

    const lastStatusWrite = updateSet.mock.calls
      .map((call) => call[0] as { lastStatus?: string })
      .find((set) => set.lastStatus !== undefined);
    expect(lastStatusWrite?.lastStatus).toBe('failed');
  });

  it('records the reported count on the session for later forensics', async () => {
    seedSession(SCHEDULE_META);
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'completed',
        metadata: {},
      },
    ]);

    await patchAsDevice({ status: 'completed', toolCallCount: 12 });

    expect(persistedUpdate().status).toBe('completed');
    expect(persistedUpdate().failureReason).toBeUndefined();
    expect(persistedUpdate().metadata).toMatchObject({
      source: 'schedule.run',
      scheduleId: SCHEDULE_ID,
      toolCallCount: 12,
    });
  });

  it('leaves a run from a runner that cannot report the count alone', async () => {
    seedSession(SCHEDULE_META);
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'completed',
        metadata: SCHEDULE_META,
      },
    ]);

    await patchAsDevice({ status: 'completed' });

    expect(persistedUpdate().status).toBe('completed');
    expect(persistedUpdate().failureReason).toBeUndefined();
    expect(persistedUpdate().metadata).toBeUndefined();
  });

  it('refuses a toolCallCount asserted by a project member rather than the device', async () => {
    selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
    seedSession(SCHEDULE_META);
    projectAccessMock.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'member',
      orgRole: null,
    });
    updateReturning.mockResolvedValueOnce([
      {
        id: SESSION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        status: 'completed',
        metadata: SCHEDULE_META,
      },
    ]);

    const res = await buildApp().request(`/api/agent-sessions/${SESSION_ID}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await signUserToken(USER_ID)}`,
      },
      body: JSON.stringify({ status: 'completed', toolCallCount: 0 }),
    });

    expect(res.status).toBe(200);
    expect(persistedUpdate().status).toBe('completed');
    expect(persistedUpdate().failureReason).toBeUndefined();
  });
});
