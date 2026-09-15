import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'y'.repeat(32);

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

// cm:why the shape `readJobGate` answers with, not the whole `jobs` row: a double omitting `ackedAt` makes the handler's new gate read every job as already acked (ISS-1014).
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
// cm:why the same `.where()` link ends two different chains — `readJobGate` stops at `.limit()`, the heartbeat's locking CTE at `.for('update')`.
const selectWhere = vi.fn(() => ({ limit: selectLimit, for: selectFor }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

// cm:why the writes through this double end the chain at different links — the heartbeat is `.set().from().where().returning()`, the ack stamp and the runtime-state sync stop at `.where()` — so it answers every shape or a branch fails on the mock rather than on the route.
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

// cm:guard `$with` and the transaction's `with` both have to answer, and a double missing either is not a loud failure: the heartbeat's `try/catch` swallows the TypeError and logs a warning, so every assertion in the file still passes while the write under it never happens (found on ISS-1014).
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

describe('jobs/events-routes POST /:id/events', () => {
  beforeEach(resetMocks);

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with 401 when no auth header is present', async () => {
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        body: body([{ kind: 'stdout', data: { line: 'hi' } }]),
      }),
    );
    expect(r.status).toBe(401);
  });

  it('rejects with 401 for an invalid device token', async () => {
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'bogus',
        body: body([{ kind: 'stdout', data: {} }]),
      }),
    );
    expect(r.status).toBe(401);
  });

  it('rejects with 403 when the job is dispatched to a different device', async () => {
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-2-token',
        body: body([{ kind: 'stdout', data: {} }]),
      }),
    );
    expect(r.status).toBe(403);
  });

  it('rejects with 409 when the job is in a terminal state', async () => {
    jobRow.status = 'done';
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([{ kind: 'stdout', data: {} }]),
      }),
    );
    expect(r.status).toBe(409);
    const json = (await r.json()) as { code?: string };
    expect(json.code).toBe('JOB_TERMINATED');
  });

  it('rejects with 400 on empty events array', async () => {
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([]),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('rejects with 400 on > 100 events', async () => {
    const app = buildApp();
    const tooMany = Array.from({ length: 101 }, () => ({ kind: 'stdout', data: {} }));
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body(tooMany),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('rejects with 404 when the job row is missing', async () => {
    selectLimit.mockImplementationOnce(async () => []);
    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([{ kind: 'stdout', data: {} }]),
      }),
    );
    expect(r.status).toBe(404);
  });

  it('accepts a batch, assigns contiguous monotonic seq, and publishes per event', async () => {
    // Two execute calls: advisory_xact_lock + MAX(seq) query.
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([
      { seq: 1, kind: 'stdout', ts: new Date('2026-04-24T00:00:00Z'), data: { i: 0 } },
      { seq: 2, kind: 'stdout', ts: new Date('2026-04-24T00:00:01Z'), data: { i: 1 } },
      { seq: 3, kind: 'progress', ts: new Date('2026-04-24T00:00:02Z'), data: { pct: 50 } },
    ]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([
          { kind: 'stdout', data: { i: 0 } },
          { kind: 'stdout', data: { i: 1 } },
          { kind: 'progress', data: { pct: 50 } },
        ]),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { accepted: number; firstSeq: number; lastSeq: number };
    expect(json).toEqual({ accepted: 3, firstSeq: 1, lastSeq: 3 });

    expect(insertValues).toHaveBeenCalledTimes(1);
    const vals = insertValues.mock.calls[0]?.[0] as Array<{ seq: number }>;
    expect(vals.map((v) => v.seq)).toEqual([1, 2, 3]);

    expect(publishMock).toHaveBeenCalledTimes(3);
    expect(publishMock).toHaveBeenCalledWith(
      'project:proj-1',
      expect.objectContaining({
        event: 'job.event',
        data: expect.objectContaining({ jobId: validJobId, seq: 1 }),
      }),
    );
  });
});

describe('jobs/events-routes · the session heartbeat and the ack stamp', () => {
  beforeEach(resetMocks);

  it('flips linked agent_session queued→running on first event and broadcasts status', async () => {
    jobRow.agentSessionId = 'session-1';
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([{ seq: 1, kind: 'stdout', ts: new Date(), data: {} }]);
    updateReturning.mockResolvedValueOnce([
      { id: 'session-1', projectId: 'proj-1', deviceId: 'dev-1', startedRunning: true },
    ]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([{ kind: 'stdout', data: {} }]),
      }),
    );
    expect(r.status).toBe(200);

    // cm:why 2 and no more — the ack-fallback stamp plus the ONE heartbeat statement; the CAS-then-fallback pair it replaced spent two on the session alone (ISS-1014).
    expect(dbUpdate).toHaveBeenCalledTimes(2);
    expect(updateFrom).toHaveBeenCalledTimes(1);
    const ackSetArg = updateSet.mock.calls[0]?.[0] as {
      ackedAt?: Date;
      killRequestedAt?: Date | null;
    };
    expect(ackSetArg?.ackedAt).toBeInstanceOf(Date);
    // cm:guard clears the kill columns in lockstep with the explicit ack route — a kill requested before the runner claimed the job must not survive as confirmation for a later reap (ISS-785)
    expect(ackSetArg).toMatchObject({
      killRequestedAt: null,
      killConfirmedAt: null,
      killOutcome: null,
    });
    const setArg = updateSet.mock.calls[1]?.[0] as {
      status?: string;
      startedAt?: unknown;
      lastHeartbeatAt?: Date;
    };
    expect(setArg?.status).toBe('running');
    expect(setArg?.lastHeartbeatAt).toBeInstanceOf(Date);
    // cm:why `startedAt` arrives as SQL and not a Date — it is a CASE that stamps only on the flip.
    expect(setArg?.startedAt).toBeDefined();

    // job.event (1) + agent-session.status to projectRoom + deviceRoom = 3 publishes
    expect(publishMock).toHaveBeenCalledTimes(3);
    expect(publishMock).toHaveBeenCalledWith(
      'project:proj-1',
      expect.objectContaining({
        event: 'agent-session.status',
        data: expect.objectContaining({ sessionId: 'session-1', status: 'running' }),
      }),
    );
    expect(publishMock).toHaveBeenCalledWith(
      'device:dev-1',
      expect.objectContaining({ event: 'agent-session.status' }),
    );
  });

  it('bumps an already-running session with one UPDATE and no status broadcast', async () => {
    jobRow.agentSessionId = 'session-1';
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([{ seq: 1, kind: 'stdout', ts: new Date(), data: {} }]);
    updateReturning.mockResolvedValueOnce([
      { id: 'session-1', projectId: 'proj-1', deviceId: 'dev-1', startedRunning: false },
    ]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([{ kind: 'stdout', data: {} }]),
      }),
    );
    expect(r.status).toBe(200);

    // cm:why 2 rather than the 3 this path used to spend — a CAS that matched nothing, then the bump (ISS-1014).
    expect(dbUpdate).toHaveBeenCalledTimes(2);
    expect(updateFrom).toHaveBeenCalledTimes(1);
    const heartbeatSetArg = updateSet.mock.calls[1]?.[0] as {
      status?: string;
      lastHeartbeatAt?: Date;
    };
    expect(heartbeatSetArg?.status).toBe('running');
    expect(heartbeatSetArg?.lastHeartbeatAt).toBeInstanceOf(Date);

    // No agent-session.status broadcast — only the job.event publish.
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      'project:proj-1',
      expect.objectContaining({ event: 'job.event' }),
    );
  });

  it('skips agent_sessions update when job has no linked session', async () => {
    jobRow.agentSessionId = null;
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([{ seq: 1, kind: 'stdout', ts: new Date(), data: {} }]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([{ kind: 'stdout', data: {} }]),
      }),
    );
    expect(r.status).toBe(200);

    // cm:why one and not two: with no linked session the heartbeat is never reached, so only the ack-fallback stamp fires.
    expect(dbUpdate).toHaveBeenCalledTimes(1);
    const ackOnlySetArg = updateSet.mock.calls[0]?.[0] as { ackedAt?: Date; status?: string };
    expect(ackOnlySetArg?.ackedAt).toBeInstanceOf(Date);
    expect(ackOnlySetArg?.status).toBeUndefined();
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('continues seq across batches (baseSeq = prior MAX)', async () => {
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 5 }]);
    insertReturning.mockResolvedValueOnce([
      { seq: 6, kind: 'stdout', ts: new Date(), data: {} },
      { seq: 7, kind: 'stdout', ts: new Date(), data: {} },
    ]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([
          { kind: 'stdout', data: {} },
          { kind: 'stdout', data: {} },
        ]),
      }),
    );
    expect(r.status).toBe(200);
    const json = (await r.json()) as { firstSeq: number; lastSeq: number };
    expect(json.firstSeq).toBe(6);
    expect(json.lastSeq).toBe(7);
    const vals = insertValues.mock.calls[0]?.[0] as Array<{ seq: number }>;
    expect(vals.map((v) => v.seq)).toEqual([6, 7]);
  });
});

describe('jobs/events-routes · a park is not a heartbeat', () => {
  beforeEach(resetMocks);

  // cm:guard assert on the SET PAYLOAD, never on a raw `db.update()` count. Three different rules write through the same mock — the ack fallback, the heartbeat sync and the runtime-state sync — so a count says only "some rule fired" and goes red whenever any unrelated one is added, which is how these three tests broke on a change that did not touch them.
  const sets = (key: string) =>
    updateSet.mock.calls.filter((c) => key in ((c[0] ?? {}) as object)).length;
  const stateWritten = () =>
    (
      updateSet.mock.calls.find((c) => 'runtimeState' in ((c[0] ?? {}) as object))?.[0] as
        | { runtimeState?: string }
        | undefined
    )?.runtimeState;

  // cm:guard the park's whole contract, and it arrives by a SECOND door: agent-sessions/routes.ts already refuses to treat `awaiting_input` as activity on the PATCH, and a job event carrying the same fact must be refused too. Without this the runner announces a park and stamps the session healthy in the same breath — `VISION: state-never-lies`, and the phase 2 exemption would be undone by the door nobody guarded.
  it('does not bump the heartbeat for a batch that only announces a park', async () => {
    jobRow.agentSessionId = 'session-1';
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([
      { seq: 1, kind: 'progress', ts: new Date(), data: { runtimeState: 'awaiting_input' } },
    ]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([{ kind: 'progress', data: { runtimeState: 'awaiting_input' } }]),
      }),
    );
    expect(r.status).toBe(200);
    expect(sets('lastHeartbeatAt')).toBe(0);
    expect(stateWritten()).toBe('awaiting_input');
  });

  // cm:guard the discriminating half — every OTHER state is activity. A rule that skipped the bump for any `runtimeState` row would park a working session outside the quiet clock, which is the un-reapable `running` row phase 2's guard names.
  it('still bumps the heartbeat when the session says it is working', async () => {
    jobRow.agentSessionId = 'session-1';
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([
      { seq: 1, kind: 'progress', ts: new Date(), data: { runtimeState: 'working' } },
    ]);
    updateReturning.mockResolvedValueOnce([]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([{ kind: 'progress', data: { runtimeState: 'working' } }]),
      }),
    );
    expect(r.status).toBe(200);
    expect(sets('lastHeartbeatAt')).toBeGreaterThan(0);
    expect(stateWritten()).toBe('working');
  });

  // cm:guard a MIXED batch is activity — the park is only quiet when nothing else happened in the same window. Reading "contains a park" as "is a park" would let one parked row silence a batch that also carried real tool output.
  it('bumps the heartbeat when a park arrives alongside real work', async () => {
    jobRow.agentSessionId = 'session-1';
    txExecute.mockResolvedValueOnce([]);
    txExecute.mockResolvedValueOnce([{ max_seq: 0 }]);
    insertReturning.mockResolvedValueOnce([
      { seq: 1, kind: 'stdout', ts: new Date(), data: {} },
      { seq: 2, kind: 'progress', ts: new Date(), data: { runtimeState: 'awaiting_input' } },
    ]);
    updateReturning.mockResolvedValueOnce([]);

    const app = buildApp();
    const r = await app.fetch(
      req(`/api/jobs/${validJobId}/events`, {
        method: 'POST',
        token: 'dev-1-token',
        body: body([
          { kind: 'stdout', data: {} },
          { kind: 'progress', data: { runtimeState: 'awaiting_input' } },
        ]),
      }),
    );
    expect(r.status).toBe(200);
    expect(sets('lastHeartbeatAt')).toBeGreaterThan(0);
    expect(stateWritten()).toBe('awaiting_input');
  });
});
