/**
 * ISS-1279 — one deploy reaches one environment at a time, from the dispatch
 * side: which environments a release asks to hold, and the moments it gives
 * them back. That the ask itself is atomic is proved against a real Postgres in
 * `tests/integration/deploy-environment-lock-e2e.test.ts`, because a lock is
 * only a lock if two callers arriving together get different answers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectQueue: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal chainable drizzle stub
function makeSelect(): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const p: any = {
    from: () => p,
    where: () => p,
    orderBy: () => p,
    limit: () => p,
    then: (resolve: (v: unknown) => void) => resolve(selectQueue.shift() ?? []),
  };
  return p;
}
// biome-ignore lint/suspicious/noExplicitAny: minimal chainable drizzle stub
function makeUpdate(): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const u: any = {
    set: () => u,
    where: () => u,
    then: (resolve: (v: unknown) => void) => resolve(undefined),
  };
  return u;
}

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => makeSelect()), update: vi.fn(() => makeUpdate()) },
}));

const acquireLocksMock = vi.fn(async (_request: unknown, _environments: readonly string[]) => {});
/** What `deploy_locks` holds for this run, read before the deploy-hold record is (ISS-1279). */
const LOCKS = [
  { environment: 'preview', acquiredAt: '2026-09-27T00:00:00.000Z' },
  { environment: 'live', acquiredAt: '2026-09-27T00:00:00.000Z' },
];
/** What a give-back with NOTHING queued may free: only the environments this dispatch took. */
const PREVIEW_ONLY = [LOCKS[0]];
const LIVE_ONLY = [LOCKS[1]];
const releaseLocksMock = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('./deploy-lock.js', async () => {
  const real = await vi.importActual<typeof import('./deploy-lock.js')>('./deploy-lock.js');
  return {
    ...real,
    acquireDeployLocks: (request: unknown, environments: readonly string[]) =>
      acquireLocksMock(request, environments),
    readDeployLocksHeld: async () => LOCKS,
    releaseDeployLocksForRun: (...a: unknown[]) => releaseLocksMock(...(a as [string])),
  };
});

const enqueueSpy = vi.fn();
vi.mock('../integrations/queue.js', () => ({
  enqueueOutboundDispatch: (job: unknown) => enqueueSpy(job),
}));

const findDeliverySpy = vi.fn();
vi.mock('../integrations/deliveries.js', () => ({
  findDeliveryByRequestId: (id: string, req: string) => findDeliverySpy(id, req),
}));

const listBindingsSpy = vi.fn();
vi.mock('../integrations/store.js', () => ({
  listActiveDeployBindingsForProvider: (...a: unknown[]) => listBindingsSpy(...(a as [])),
}));

vi.mock('./runs.js', () => ({
  setCurrentStep: vi.fn(),
  RELEASE_DEPLOY_IN_FLIGHT_STEP: 'release.deploy.in_flight',
}));

const openHoldSpy = vi.fn(async (_args: unknown) => true);
const abandonHoldSpy = vi.fn(async (_runId: string, _requestId: string) => undefined);
let heldNow: Record<string, { status: string }> = {};
vi.mock('./deploy-confirmations.js', () => ({
  openDeployDispatchHold: (args: unknown) => openHoldSpy(args),
  abandonDeployDispatchHold: (runId: string, requestId: string) => abandonHoldSpy(runId, requestId),
  readDeployHolds: async () => heldNow,
  DEPLOY_CONFIRM_WINDOW_MS: 30 * 60_000,
}));

vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn() },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { tryDispatchCoolifyRelease } = await import('./release-coolify.js');
const { db } = await import('../db/client.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = 'run-1';
const STAGING_INT = 'a1111111-1111-4111-8111-111111111111';
const PROD_INT = 'b2222222-2222-4222-8222-222222222222';
const SECOND_INT = 'c3333333-3333-4333-8333-333333333333';
const SHARED_APP = 'y8w4c4kss8ogo8gc44ow44kc';

const pairOf = (id: string, stages: string[], config: unknown = {}) => ({
  binding: {
    id,
    projectId: PROJECT_ID,
    provider: 'coolify',
    role: 'deploy',
    stages,
    config,
    active: true,
  },
  connection: { id, provider: 'coolify', config: {}, active: true },
});

const stagingPair = pairOf(STAGING_INT, ['preview']);
const prodPair = pairOf(PROD_INT, ['live']);
const sharedBox = (id: string, stages: string[]) =>
  pairOf(id, stages, { targets: [{ label: 'App', resourceUuid: SHARED_APP }] });

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  enqueueSpy.mockReset();
  enqueueSpy.mockImplementation(() => undefined);
  findDeliverySpy.mockReset();
  listBindingsSpy.mockReset();
  listBindingsSpy.mockResolvedValue([]);
  acquireLocksMock.mockReset();
  acquireLocksMock.mockResolvedValue(undefined);
  releaseLocksMock.mockReset();
  releaseLocksMock.mockResolvedValue(0);
  openHoldSpy.mockReset();
  openHoldSpy.mockResolvedValue(true);
  abandonHoldSpy.mockReset();
  abandonHoldSpy.mockResolvedValue(undefined);
  heldNow = {};
});

describe('tryDispatchCoolifyRelease — the environment hold', () => {
  const envsAsked = () => acquireLocksMock.mock.calls[0]?.[1];
  const subjectAsked = () =>
    (acquireLocksMock.mock.calls[0]?.[0] as { subject: string } | undefined)?.subject;

  it('asks for nothing at all when the caller did not ask for the hold', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair]);

    await tryDispatchCoolifyRelease({ projectId: PROJECT_ID, issueId: ISSUE_ID, runId: RUN_ID });

    expect(acquireLocksMock).not.toHaveBeenCalled();
    expect(releaseLocksMock).not.toHaveBeenCalled();
  });

  it('holds the stages of the bindings it is about to dispatch', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair]);
    heldNow = { 'target:del-a': { status: 'pending' } };

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    expect(envsAsked()).toEqual(['preview']);
    expect(acquireLocksMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });
    expect(subjectAsked()).toContain(STAGING_INT);
    expect(releaseLocksMock).not.toHaveBeenCalled();
  });

  it('holds `live` for a preview binding that deploys to a live binding’s application', async () => {
    listBindingsSpy.mockResolvedValueOnce([
      sharedBox(STAGING_INT, ['preview']),
      sharedBox(PROD_INT, ['live']),
    ]);
    selectQueue.push([{ status: 'running' }]);
    selectQueue.push([{ agentConfig: { pipelineConfig: { autoProdDeploy: true } } }]);

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      integrationId: STAGING_INT,
      takeEnvironmentLock: true,
    });

    expect(envsAsked()).toEqual(['live', 'preview']);
  });

  it('asks for no hold where there is no binding to dispatch', async () => {
    listBindingsSpy.mockResolvedValueOnce([]);

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    expect(outcome.reason).toBe('no-integration');
    expect(acquireLocksMock).not.toHaveBeenCalled();
    expect(releaseLocksMock).not.toHaveBeenCalled();
  });

  it('gives the hold back when every binding parks for a human', async () => {
    listBindingsSpy.mockResolvedValueOnce([prodPair]);
    selectQueue.push([{ status: 'running' }]);
    selectQueue.push([]); // projectAutoProdDeploy: the gate stays on
    selectQueue.push([]); // getProdGateStateForRun: unconfirmed
    selectQueue.push([{ metadata: {} }]); // markPendingHumanConfirm

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    expect(outcome.pendingHumanConfirm).toBe(true);
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(acquireLocksMock).toHaveBeenCalledTimes(1);
    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID, LIVE_ONLY]]);
  });

  it('writes the gate state a parked binding is resumed from', async () => {
    listBindingsSpy.mockResolvedValueOnce([prodPair]);
    selectQueue.push([{ status: 'running' }]);
    selectQueue.push([]);
    selectQueue.push([]);
    selectQueue.push([{ metadata: {} }]);

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    expect((db.update as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
  });
});

// The hold is given back the moment nothing of this run is reaching the environment any more,
// and kept for as long as something is — a throw partway through the fan-out is neither by itself.
describe('tryDispatchCoolifyRelease — giving the hold back', () => {
  it('gives the hold back when the dispatch throws before anything is enqueued', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair]);
    enqueueSpy.mockImplementation(() => {
      throw new Error('queue is down');
    });

    await expect(
      tryDispatchCoolifyRelease({
        projectId: PROJECT_ID,
        issueId: null,
        runId: RUN_ID,
        takeEnvironmentLock: true,
      }),
    ).rejects.toThrow('queue is down');

    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID, PREVIEW_ONLY]]);
  });

  // A target that settles between two enqueues reads every hold registered so far as the whole
  // set, closes the run and frees the environment — and the binding not yet reached is then
  // dispatched behind both. Every hold is opened before the first enqueue so that window is shut.
  it('gives the hold back when the binding that was enqueued has already settled', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair, pairOf(SECOND_INT, ['preview'])]);
    enqueueSpy
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('queue is down');
      });
    // The one that WAS enqueued settled before this throw was caught, so nothing of this run is
    // reaching the environment any more — and a count of successful enqueues cannot say so.
    heldNow = { 'target:del-a': { status: 'succeeded' } };

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    }).catch(() => undefined);

    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID, LOCKS]]);
  });

  // A terminal run refuses its dispatch placeholders, so the record stays empty while Coolify
  // builds what was queued anyway. Reading that emptiness as an idle environment frees the hold
  // under a live deploy — the one direction this row may never get wrong. The expiry ends it.
  it('frees nothing when the run refused every placeholder and the deploys went out anyway', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair]);
    openHoldSpy.mockResolvedValue(false);
    heldNow = {};

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(releaseLocksMock).not.toHaveBeenCalled();
  });

  it('opens every dispatch hold before the first binding is enqueued', async () => {
    const order: string[] = [];
    openHoldSpy.mockImplementation(async () => {
      order.push('hold');
      return true;
    });
    enqueueSpy.mockImplementation(() => order.push('enqueue'));
    listBindingsSpy.mockResolvedValueOnce([stagingPair, pairOf(SECOND_INT, ['preview'])]);

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    expect(order).toEqual(['hold', 'hold', 'enqueue', 'enqueue']);
  });

  // A run going terminal between two bindings of one fan-out would otherwise refuse the second
  // placeholder, leaving the first binding's settlement reading a record with nothing pending in
  // it — and freeing the environment while the second binding is still building (ISS-1279).
  it('lets a binding of a live fan-out be recorded on the authority of its sibling', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair, pairOf(SECOND_INT, ['preview'])]);

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    const authorised = openHoldSpy.mock.calls.map(
      (c) => (c[0] as { authorisedBySibling?: boolean }).authorisedBySibling,
    );
    expect(authorised).toEqual([false, true]);
  });

  it('gives the hold back when a dispatch hold cannot be opened at all', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair]);
    openHoldSpy.mockImplementation(() => {
      throw new Error('metadata write failed');
    });

    await expect(
      tryDispatchCoolifyRelease({
        projectId: PROJECT_ID,
        issueId: null,
        runId: RUN_ID,
        takeEnvironmentLock: true,
      }),
    ).rejects.toThrow('metadata write failed');

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID, PREVIEW_ONLY]]);
  });

  it('keeps the hold when the dispatch throws after one binding is already on its way', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair, pairOf(SECOND_INT, ['preview'])]);
    heldNow = { 'target:del-a': { status: 'pending' } };
    enqueueSpy
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('queue is down');
      });

    await expect(
      tryDispatchCoolifyRelease({
        projectId: PROJECT_ID,
        issueId: null,
        runId: RUN_ID,
        takeEnvironmentLock: true,
      }),
    ).rejects.toThrow('queue is down');

    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(releaseLocksMock).not.toHaveBeenCalled();
  });

  // A placeholder whose deploy was never queued is a hold nothing can settle: the run cannot
  // close, and the environment stays held to that hold's deadline with nothing deploying.
  it('forgets the placeholder of a binding it never managed to enqueue', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair, pairOf(SECOND_INT, ['preview'])]);
    enqueueSpy
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('queue is down');
      });

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    }).catch(() => undefined);

    expect(abandonHoldSpy.mock.calls.map((c) => c[0])).toEqual([RUN_ID]);
    const kept = openHoldSpy.mock.calls.map((c) => (c[0] as { requestId: string }).requestId);
    expect(abandonHoldSpy.mock.calls[0]?.[1]).toBe(kept[1]);
  });
});

// A release that parked for a human and is confirmed later is the same release
// reaching the same box. A park the landing auto-subscriber opened carries no
// hold and resumes exactly as it always has.
