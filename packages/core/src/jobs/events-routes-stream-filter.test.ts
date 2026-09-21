import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const dbWith = vi.fn((_alias: string) => ({
  as: (_q: unknown) => ({ id: 'prev.id', status: 'prev.status' }),
}));
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

describe('jobs/events-routes stream_event persistence filter', () => {
  beforeEach(resetMocks);
  afterEach(() => {
    vi.clearAllMocks();
  });

  const sets = (key: string) =>
    updateSet.mock.calls.filter((c) => key in ((c[0] ?? {}) as object)).length;

  const line = (l: unknown) => ({ kind: 'stdout', data: { line: l } });
  const delta = line({ type: 'stream_event', event: { type: 'content_block_delta' } });

  it('stores the frames a reader consumes and drops the stream_event ones', async () => {
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([
      { seq: 1, kind: 'stdout', ts: new Date(), data: {} },
      { seq: 2, kind: 'stdout', ts: new Date(), data: {} },
    ]);
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([line({ type: 'assistant' }), delta, line({ type: 'result' })]),
      }),
    );
    expect(r.status).toBe(200);
    const vals = insertValues.mock.calls[0]?.[0] as Array<{ data: { line: { type: string } } }>;
    expect(vals.map((v) => v.data.line.type)).toEqual(['assistant', 'result']);
  });

  it('stores a frame type it has never seen', async () => {
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([{ seq: 1, kind: 'stdout', ts: new Date(), data: {} }]);
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([line({ type: 'frame_invented_next_year' })]),
      }),
    );
    expect(r.status).toBe(200);
    const vals = insertValues.mock.calls[0]?.[0] as Array<{ data: { line: { type: string } } }>;
    expect(vals.map((v) => v.data.line.type)).toEqual(['frame_invented_next_year']);
  });

  it('still bumps the session heartbeat when every frame is filtered out', async () => {
    jobRow.agentSessionId = 'session-1';
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([delta]),
      }),
    );
    expect(r.status).toBe(200);
    expect(txInsert).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(sets('lastHeartbeatAt')).toBeGreaterThan(0);
    expect(await r.json()).toEqual({ accepted: 0, firstSeq: null, lastSeq: null });
  });
});
