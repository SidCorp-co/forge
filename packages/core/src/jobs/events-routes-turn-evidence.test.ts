import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'y'.repeat(32);

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

const jobRow: {
  id: string;
  projectId: string;
  deviceId: string;
  status: string;
  agentSessionId: string | null;
  ackedAt: Date | null;
} = {
  id: 'job-1',
  projectId: 'proj-1',
  deviceId: 'dev-1',
  status: 'running',
  agentSessionId: null,
  ackedAt: null,
};

const verifyDeviceCredential = vi.fn(async (token: string) => {
  if (token === 'dev-1-token') {
    return { id: 'dev-1', ownerId: 'u-1', name: 'd1', platform: 'linux' };
  }
  if (token === 'dev-2-token') {
    return { id: 'dev-2', ownerId: 'u-2', name: 'd2', platform: 'linux' };
  }
  return null;
});

vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: (t: string) => verifyDeviceCredential(t),
}));

const insertValues = vi.fn();
const insertReturning = vi.fn();
const txInsert = vi.fn(() => ({
  values: (vals: unknown[]) => {
    insertValues(vals);
    return { returning: insertReturning };
  },
}));
const txExecute = vi.fn();
const txWith = vi.fn(() => ({ update: dbUpdate }));
const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  const tx = { execute: txExecute, insert: txInsert, update: dbUpdate, with: txWith };
  return fn(tx);
});

const selectFor = vi.fn(() => ({}));
const selectLimit = vi.fn(async () => [jobRow]);
const selectWhere = vi.fn(() => ({ limit: selectLimit, for: selectFor }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

const updateReturning = vi.fn(async () => [] as unknown[]);
const updateWhere = vi.fn(() => {
  const p = {
    returning: updateReturning,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  };
  return p as unknown as { returning: typeof updateReturning } & PromiseLike<unknown>;
});
const dbWith = vi.fn((_a: string) => ({ as: () => ({ id: 'prev.id', status: 'prev.status' }) }));
const updateFrom = vi.fn(() => ({ where: updateWhere }));
const updateSet = vi.fn((..._args: unknown[]) => ({ where: updateWhere, from: updateFrom }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect, transaction, update: dbUpdate, $with: dbWith },
}));

const publishMock = vi.fn(() => 0);
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishMock },
}));

const { jobEventsRoutes } = await import('./events-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

const validJobId = '11111111-1111-4111-8111-111111111111';
const body = (events: unknown[]) => JSON.stringify({ events });

function resetMocks(): void {
  vi.clearAllMocks();
  selectLimit.mockImplementation(async () => [jobRow]);
  jobRow.status = 'running';
  jobRow.deviceId = 'dev-1';
  jobRow.agentSessionId = null;
  jobRow.ackedAt = null;
  insertReturning.mockReset();
  txExecute.mockReset();
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
  updateSet.mockClear();
  updateFrom.mockClear();
  txWith.mockClear();
  dbWith.mockClear();
  updateWhere.mockClear();
  dbUpdate.mockClear();
}

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/jobs', jobEventsRoutes);
  app.onError(errorHandler);
  return app;
}

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  const { token: _t, ...rest } = init;
  return new Request(`http://localhost${path}`, { ...rest, headers });
}

/*
 * ISS-1101 — a beat is not a turn.
 *
 * What this lane can see is the SET PAYLOAD: whether the one heartbeat
 * statement carried `status` this time. What it CANNOT see is the row that came
 * back — `updateReturning` is a mock answering a literal, so an assertion about
 * the `startedRunning` flag or about the session's status afterwards passes here
 * whatever SQL was built. Both are asserted where they can fail, against real
 * Postgres, in `tests/integration/session-turn-evidence-e2e.test.ts`; a green
 * planted here (`startedRunning` left reading `prev.status` alone) stayed green,
 * which is why it is not here.
 */
describe('jobs/events-routes · a beat is not a turn', () => {
  beforeEach(resetMocks);

  const heartbeatSet = () =>
    updateSet.mock.calls.find((c) => 'lastHeartbeatAt' in ((c[0] ?? {}) as object))?.[0] as
      | { status?: string; startedAt?: unknown; lastHeartbeatAt?: Date }
      | undefined;

  async function postOne(event: { kind: string; data: Record<string, unknown> }) {
    jobRow.agentSessionId = 'session-1';
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([
      { seq: 1, kind: event.kind, ts: new Date(), data: event.data },
    ]);
    updateReturning.mockResolvedValueOnce([
      { id: 'session-1', projectId: 'proj-1', deviceId: 'dev-1', startedRunning: false },
    ]);
    const app = buildApp();
    return app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([event]),
      }),
    );
  }

  it("writes no status for the pane lane's own beat, which carries no runtimeState", async () => {
    const r = await postOne({ kind: 'progress', data: { source: 'pool_jobs', state: 'running' } });

    expect(r.status).toBe(200);
    expect(heartbeatSet()?.status).toBeUndefined();
    expect(heartbeatSet()?.startedAt).toBeUndefined();
  });

  it('writes no status for a beat that reports starting', async () => {
    const r = await postOne({ kind: 'progress', data: { runtimeState: 'starting' } });

    expect(r.status).toBe(200);
    expect(heartbeatSet()?.status).toBeUndefined();
  });

  it('still bumps the heartbeat for a beat that reports nothing about the agent', async () => {
    const r = await postOne({ kind: 'progress', data: { source: 'pool_jobs', state: 'running' } });

    expect(r.status).toBe(200);
    expect(heartbeatSet()?.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it('writes the status for a beat that reports working', async () => {
    const r = await postOne({ kind: 'progress', data: { runtimeState: 'working' } });

    expect(r.status).toBe(200);
    expect(heartbeatSet()?.status).toBe('running');
    expect(heartbeatSet()?.startedAt).toBeDefined();
  });

  it('writes no status for a beat that reports closed', async () => {
    const r = await postOne({ kind: 'progress', data: { runtimeState: 'closed' } });

    expect(r.status).toBe(200);
    expect(heartbeatSet()?.status).toBeUndefined();
  });

  it('writes the status for a tool call, which cannot exist unless a turn was asked', async () => {
    const r = await postOne({ kind: 'tool_call', data: { name: 'Bash' } });

    expect(r.status).toBe(200);
    expect(heartbeatSet()?.status).toBe('running');
  });

  it('writes the status when a bare beat arrives alongside a working report', async () => {
    jobRow.agentSessionId = 'session-1';
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([
      { seq: 1, kind: 'progress', ts: new Date(), data: { source: 'pool_jobs' } },
      { seq: 2, kind: 'progress', ts: new Date(), data: { runtimeState: 'working' } },
    ]);
    updateReturning.mockResolvedValueOnce([]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([
          { kind: 'progress', data: { source: 'pool_jobs' } },
          { kind: 'progress', data: { runtimeState: 'working' } },
        ]),
      }),
    );

    expect(r.status).toBe(200);
    expect(heartbeatSet()?.status).toBe('running');
  });
});
