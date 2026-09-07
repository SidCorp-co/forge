/**
 * `runtimeState` is a claim only a runner may make — ISS-873 phase 2.
 *
 * Two rules the route owns and nothing downstream can recover from. The state
 * comes from the DEVICE principal only, because `awaiting_input` exempts a
 * session from the heartbeat hop and a member who could set it could park any
 * session outside the quiet clock forever. And a park is not activity: it must
 * not stamp `lastHeartbeatAt`, or the row claims progress while it waits on a
 * human (`VISION: state-never-lies`).
 *
 * Asserted on the UPDATE payload the handler builds, not on whether a mock was
 * called — that payload is the whole observable behaviour of this path.
 *
 * ISS-877 added a second claim the body may not make, for the same reason in a
 * different column: `failureReason` is a taxonomy token the server derives, and
 * a caller who could set it could write anything into the one field an operator
 * reads to learn why a session died.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// cm:guard PAT-SHAPED, because a box now presents an ordinary `forge_pat_*` carrying `device_id` (ISS-932). An opaque string here never reaches the device branch at all — `requireUserOrDevice` routes on `isPatLike` — so the mock would go unconsulted and the suite would prove nothing about the device path.
const DEVICE_PAT = `forge_pat_dev_${'a'.repeat(64)}`;

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

const verifyDeviceCredentialMock = vi.fn(async (_token: unknown) => null as { id: string } | null);
vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: (token: unknown) => verifyDeviceCredentialMock(token),
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

const { agentSessionRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

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
  verifyDeviceCredentialMock.mockReset();
  verifyDeviceCredentialMock.mockResolvedValue(null);
});

/** Seed the session row the PATCH handler loads, then its post-write return. */

function persisted() {
  return updateSet.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
}

function seedRunningSession() {
  selectLimit.mockResolvedValue([
    {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
      userId: USER_ID,
      status: 'running',
      messages: [],
      metadata: {},
      failureReason: null,
    },
  ]);
  updateReturning.mockResolvedValueOnce([
    { id: SESSION_ID, projectId: PROJECT_ID, deviceId: DEVICE_ID, status: 'running', metadata: {} },
  ]);
}

async function patchAsDevice(body: Record<string, unknown>) {
  verifyDeviceCredentialMock.mockResolvedValueOnce({ id: DEVICE_ID });
  return buildApp().request(`/api/agent-sessions/${SESSION_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DEVICE_PAT}` },
    body: JSON.stringify(body),
  });
}

async function patchAsMember(body: Record<string, unknown>) {
  projectAccessMock.mockResolvedValue({
    projectId: PROJECT_ID,
    role: 'member',
    orgRole: 'member',
    isOwner: false,
  });
  const token = await signUserToken(USER_ID);
  return buildApp().request(`/api/agent-sessions/${SESSION_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/agent-sessions/:id — who may say a session is parked', () => {
  it('records the state a runner reports', async () => {
    seedRunningSession();
    const res = await patchAsDevice({ runtimeState: 'awaiting_input' });
    expect(res.status).toBe(200);
    expect(persisted()?.runtimeState).toBe('awaiting_input');
  });

  // cm:guard the security half. `awaiting_input` is the one value that exempts a row from the heartbeat hop, so a member who could assert it could hold one of the box's few duplex session slots indefinitely with a plain PATCH.
  it('ignores the same claim from a project member', async () => {
    seedRunningSession();
    const res = await patchAsMember({ runtimeState: 'awaiting_input' });
    expect(res.status).toBe(200);
    expect(persisted()).not.toHaveProperty('runtimeState');
  });

  it('does not stamp a heartbeat for a session parked on a human', async () => {
    seedRunningSession();
    await patchAsDevice({ runtimeState: 'awaiting_input' });
    expect(persisted()).not.toHaveProperty('lastHeartbeatAt');
  });

  it('does stamp one for a session that says it is working', async () => {
    seedRunningSession();
    await patchAsDevice({ runtimeState: 'working' });
    expect(persisted()?.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it('refuses a state the column does not have', async () => {
    seedRunningSession();
    const res = await patchAsDevice({ runtimeState: 'parked' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/agent-sessions/:id — ISS-877 failureReason is server-derived', () => {
  // cm:guard the `{ enum }` on the column stops CORE writing free text, and this stops a REQUEST supplying it — the type cannot see a value that arrives as JSON at runtime, so widening `patchSchema` to accept `failureReason` re-opens the enum-mixed-with-free-text hole from the one direction the compiler is blind to, and nothing else in the suite would notice.
  it('rejects the field outright rather than storing whatever arrived', async () => {
    seedRunningSession();
    const res = await patchAsDevice({
      status: 'failed',
      failureReason: 'whatever the caller felt like',
    });
    expect(res.status).toBe(400);
    expect(persisted()).toBeUndefined();
  });

  it('still accepts the same PATCH without it', async () => {
    seedRunningSession();
    const res = await patchAsDevice({ status: 'failed' });
    expect(res.status).toBe(200);
  });
});
