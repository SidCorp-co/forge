/**
 * `releaseBatchRoutes` — the HTTP half of the two refusals a project's own release
 * DECLARATION makes.
 *
 * `resolveReleaseGate` and `releaseRunnerLabelOf` each throw a named error (proved in
 * `gate.test.ts` and `channel.test.ts`); neither was caught here, so a project that
 * declares `releaseModel` with no live deploy binding — or two live bindings naming
 * different release runners — answered `500 Internal Server Error` on both the create
 * and the roster. An operator reading a 500 cannot tell a misdeclared project from a
 * broken server, which is the same silent shape the declaration exists to remove.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const createReleaseBatchMock = vi.fn();
const loadReleaseRosterMock = vi.fn();

// The error CLASSES stay real: the handler discriminates with `instanceof`, so a stub
// class would make this test pass against a handler that maps nothing.
vi.mock('./service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./service.js')>()),
  createReleaseBatch: (a: unknown) => createReleaseBatchMock(a),
  loadReleaseRoster: (a: unknown) => loadReleaseRosterMock(a),
}));

// `loadProjectAccess` is what the handler calls; stubbing the resolver underneath it
// leaves the real db-touching join in the path.
const loadAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => loadAccess(...args),
}));

const { releaseBatchRoutes } = await import('./routes.js');
const { ReleaseTargetUndeclaredError } = await import('./gate.js');
const { ReleaseRunnerAmbiguousError } = await import('./channel.js');
const { ReleaseMultiChannelUnsupportedError, ReleaseRecordMissingError } = await import(
  './service.js'
);
const { blocker, releaseBlockerError } = await import('./blockers.js');
const { releaseBlockerSentence } = await import('./blocker-sentences.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', releaseBatchRoutes);
  app.onError(errorHandler);
  return app;
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';

function mockAdmin() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
  loadAccess.mockResolvedValueOnce({
    projectId: PROJECT_ID,
    orgId: 'org-1',
    role: 'admin',
    orgRole: 'owner',
  });
}

async function token() {
  return await signUserToken(USER_ID);
}

async function createReq() {
  return await buildApp().request(`/api/projects/${PROJECT_ID}/release-batches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueIds: [ISSUE_ID] }),
  });
}

async function rosterReq() {
  return await buildApp().request(`/api/projects/${PROJECT_ID}/release-batches/roster`, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /:projectId/release-batches — the declaration refusals', () => {
  // ISS-1127 criterion 9: this text is `releaseBlockerSentence`'s, the same
  // function `GET /release-readiness` composes its own `RELEASE_TARGET_UNDECLARED`
  // entry from (`blockers.ts`'s `blocker('RELEASE_TARGET_UNDECLARED', { releaseModel })`)
  // — not the error class's own `.message`, which named the project id this
  // call is already scoped to and neither door needed.
  it('answers 409 RELEASE_TARGET_UNDECLARED, naming the declared model and the remedy', async () => {
    mockAdmin();
    createReleaseBatchMock.mockRejectedValueOnce(
      new ReleaseTargetUndeclaredError(PROJECT_ID, 'promote'),
    );

    const res = await createReq();
    const body = (await res.json()) as { code?: string; message?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('RELEASE_TARGET_UNDECLARED');
    expect(body.message).toContain('releaseModel `promote`');
    expect(body.message).toContain('no active deploy binding carrying the `live` stage');
  });

  it('answers 409 RELEASE_RUNNER_AMBIGUOUS, naming both labels', async () => {
    mockAdmin();
    createReleaseBatchMock.mockRejectedValueOnce(
      new ReleaseRunnerAmbiguousError(PROJECT_ID, ['box-a', 'box-b']),
    );

    const res = await createReq();
    const body = (await res.json()) as { code?: string; message?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('RELEASE_RUNNER_AMBIGUOUS');
    expect(body.message).toContain('box-a');
    expect(body.message).toContain('box-b');
  });

  it('answers 409 RELEASE_MULTI_CHANNEL_UNSUPPORTED, saying how many were declared', async () => {
    mockAdmin();
    createReleaseBatchMock.mockRejectedValueOnce(new ReleaseMultiChannelUnsupportedError(2));

    const res = await createReq();
    const body = (await res.json()) as { code?: string; message?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('RELEASE_MULTI_CHANNEL_UNSUPPORTED');
    expect(body.message).toContain('2 live deploy bindings');
    // The way out is carried in the refusal.
    expect(body.message).toContain('Leave exactly one binding');
  });

  it('still passes an unrelated failure through as a 500 rather than a 409', async () => {
    mockAdmin();
    createReleaseBatchMock.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    const res = await createReq();

    expect(res.status).toBe(500);
  });
});

describe('GET /:projectId/release-batches/roster — the same two refusals', () => {
  it('answers 409 RELEASE_TARGET_UNDECLARED rather than 500', async () => {
    mockAdmin();
    loadReleaseRosterMock.mockRejectedValueOnce(
      new ReleaseTargetUndeclaredError(PROJECT_ID, 'publish'),
    );

    const res = await rosterReq();
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('RELEASE_TARGET_UNDECLARED');
  });

  it('answers 409 RELEASE_RUNNER_AMBIGUOUS rather than 500', async () => {
    mockAdmin();
    loadReleaseRosterMock.mockRejectedValueOnce(
      new ReleaseRunnerAmbiguousError(PROJECT_ID, ['east', 'west']),
    );

    const res = await rosterReq();
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('RELEASE_RUNNER_AMBIGUOUS');
  });
});

/**
 * ISS-1127 — what the caller reads when the refusal is one of several.
 *
 * A refusal that is correct and mentions nothing else is the defect this issue
 * was filed for: the operator clears it, calls again, and meets the next one.
 */
describe('POST /:projectId/release-batches — every reason at once', () => {
  function refusedWith(
    err: Error,
    thrown: string,
    standing: Array<{ code: string; message: string }>,
  ) {
    Object.assign(err, {
      releaseBlockers: [
        { code: thrown, message: 'the one being thrown', evaluated: true, httpStatus: 409 },
        ...standing.map((b) => ({ ...b, evaluated: true, httpStatus: 409 })),
      ],
    });
    createReleaseBatchMock.mockRejectedValueOnce(err);
  }

  it('carries the reasons standing beside the one it threw', async () => {
    mockAdmin();
    refusedWith(new ReleaseRecordMissingError([ISSUE_ID]), 'RELEASE_RECORD_MISSING', [
      { code: 'NO_RUNNER_ONLINE', message: 'and no box is online either' },
    ]);

    const res = await createReq();
    const body = (await res.json()) as {
      code?: string;
      details?: { alsoBlocking?: Array<{ code: string }> };
    };

    expect(res.status).toBe(409);
    expect(body.code).toBe('RELEASE_RECORD_MISSING');
    expect(body.details?.alsoBlocking?.map((b) => b.code)).toEqual(['NO_RUNNER_ONLINE']);
  });

  it('never lists the reason it threw among the ones still standing', async () => {
    mockAdmin();
    refusedWith(new ReleaseRecordMissingError([ISSUE_ID]), 'RELEASE_RECORD_MISSING', []);

    const res = await createReq();
    const body = (await res.json()) as { details?: { alsoBlocking?: unknown } };

    expect(body.details?.alsoBlocking).toBeUndefined();
  });

  /** What `createReleaseBatch` throws: the report's first entry's class, carrying the report. */
  function reported(...entries: ReturnType<typeof blocker>[]) {
    const err = releaseBlockerError({
      projectId: PROJECT_ID,
      projectExists: true,
      declaration: null,
      channels: [],
      blockers: entries,
      warnings: [],
    });
    createReleaseBatchMock.mockRejectedValueOnce(err);
  }

  it('answers 503 for a check it could not run, rather than claiming a release may start', async () => {
    mockAdmin();
    reported(blocker('RELEASE_CHECK_UNEVALUATED', { check: 'runner-pool' }));

    const res = await createReq();
    const body = (await res.json()) as { code?: string; message?: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe('RELEASE_CHECK_UNEVALUATED');
    expect(body.message).toContain('runner-pool');
  });

  it('says the same sentence the readiness answer said for the same code', async () => {
    mockAdmin();
    reported(blocker('RELEASE_RECORD_MISSING', { issueIds: [ISSUE_ID] }));

    const res = await createReq();
    const body = (await res.json()) as { message?: string };

    expect(body.message).toBe(
      releaseBlockerSentence('RELEASE_RECORD_MISSING', { issueIds: [ISSUE_ID] }),
    );
  });

  // The judging run's criterion-9 failure at 9fcf2d707: the class this code is
  // thrown as carries no runners, and the door answered with the sentence for
  // a reading nobody failed to take.
  it('names the held boxes the report carried, rather than the no-reading fallback', async () => {
    mockAdmin();
    const runners = [
      {
        deviceName: 'judge-new-box',
        reason: 'never-connected',
        lastSeenSeconds: null,
        reporting: false,
      },
    ];
    reported(blocker('NO_RUNNER_ONLINE', { runners }));

    const res = await createReq();
    const body = (await res.json()) as { message?: string; details?: { runners?: unknown } };

    expect(res.status).toBe(503);
    expect(body.message).toBe(releaseBlockerSentence('NO_RUNNER_ONLINE', { runners }));
    expect(body.message).toContain('judge-new-box');
    expect(body.details?.runners).toEqual(runners);
  });

  it('carries the running batch id the report named', async () => {
    mockAdmin();
    reported(blocker('BATCH_IN_FLIGHT', { runId: 'run-9' }));

    const res = await createReq();
    const body = (await res.json()) as { details?: { runId?: string } };

    expect(body.details?.runId).toBe('run-9');
  });
});

/**
 * The whole-set review's F1 and F3, at the door: a refusal whose class the
 * enumerator lost reaches `errorHandler` as a 500, and a refusal routed around
 * `releaseBlockerHttp` drops every reason standing with it.
 */
describe('POST /:projectId/release-batches — the refusals that go through their own sentence', () => {
  it('still answers 409 for an undeclared target, rather than the 500 an unmapped class gets', async () => {
    mockAdmin();
    createReleaseBatchMock.mockRejectedValueOnce(
      new ReleaseTargetUndeclaredError(PROJECT_ID, 'publish'),
    );

    const res = await createReq();

    expect(res.status).toBe(409);
  });

  it('carries the rest of the list on a declaration refusal too', async () => {
    mockAdmin();
    const err = new ReleaseTargetUndeclaredError(PROJECT_ID, 'publish');
    Object.assign(err, {
      releaseBlockers: [
        { code: 'RELEASE_TARGET_UNDECLARED', message: 'thrown', evaluated: true, httpStatus: 409 },
        {
          code: 'RELEASE_ROSTER_EMPTY',
          message: 'nothing waiting',
          evaluated: true,
          httpStatus: 409,
        },
      ],
    });
    createReleaseBatchMock.mockRejectedValueOnce(err);

    const res = await createReq();
    const body = (await res.json()) as { details?: { alsoBlocking?: Array<{ code: string }> } };

    expect(body.details?.alsoBlocking?.map((b) => b.code)).toEqual(['RELEASE_ROSTER_EMPTY']);
  });
});
