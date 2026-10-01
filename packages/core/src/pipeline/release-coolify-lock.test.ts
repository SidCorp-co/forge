/**
 * ISS-1279 — one deploy reaches one environment at a time, from the dispatch
 * side: which environments a release asks to hold, and the moments it gives
 * them back. That the ask itself is atomic is proved against a real Postgres in
 * `tests/integration/deploy-environment-lock-e2e.test.ts`, because a lock is
 * only a lock if two callers arriving together get different answers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deployedBy, production, projectDoc } from '../project-config/release-path.fixture.js';
import type { ProjectDocument } from '../project-config/schema.js';

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
/** Every row written through `db.update`, so what a parked gate recorded can be read back. */
const updates: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal chainable drizzle stub
function makeUpdate(): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const u: any = {
    set: (row: unknown) => {
      updates.push(row);
      return u;
    },
    where: () => u,
    then: (resolve: (v: unknown) => void) => resolve(undefined),
  };
  return u;
}

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => makeSelect()), update: vi.fn(() => makeUpdate()) },
}));

/** What `deploy_locks` hands back from the acquire that took the rows (ISS-1279). */
const acquireLocksMock = vi.fn(async (_request: unknown, environments: readonly string[]) =>
  LOCKS.filter((l) => environments.includes(l.environment)),
);
const LOCKS = [
  { environment: 'staging', acquiredAt: '2026-09-27T00:00:00.000Z' },
  { environment: 'beta', acquiredAt: '2026-09-27T00:00:00.000Z' },
];
/** What a give-back with NOTHING queued may free: only the environments this dispatch took. */
const STAGING_ONLY = LOCKS.slice(0, 1);
const BETA_ONLY = LOCKS.slice(1);
const releaseLocksMock = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('./deploy-lock.js', async () => {
  const real = await vi.importActual<typeof import('./deploy-lock.js')>('./deploy-lock.js');
  return {
    ...real,
    acquireDeployLocks: (request: unknown, environments: readonly string[]) =>
      acquireLocksMock(request, environments),
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

const readDocument = vi.fn(
  async (): Promise<{ revision: number; document: ProjectDocument } | null> => null,
);
vi.mock('../project-config/service.js', () => ({
  readProjectDocument: () => readDocument(),
}));

vi.mock('./runs.js', () => ({
  setCurrentStep: vi.fn(),
  RELEASE_DEPLOY_IN_FLIGHT_STEP: 'release.deploy.in_flight',
}));

const openHoldSpy = vi.fn(async (_args: unknown) => true);
const abandonHoldSpy = vi.fn(async (_runId: string, _requestId: string) => undefined);
let heldNow: Record<string, { status: string; locks?: typeof LOCKS }> = {};
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

const pairOf = (id: string, config: unknown = {}) => ({
  binding: {
    id,
    projectId: PROJECT_ID,
    provider: 'coolify',
    role: 'deploy',
    config,
    active: true,
  },
  connection: { id, provider: 'coolify', config: {}, active: true },
});

const stagingPair = pairOf(STAGING_INT);
const prodPair = pairOf(PROD_INT);
const secondPair = pairOf(SECOND_INT);
const sharedBox = (id: string) =>
  pairOf(id, { targets: [{ label: 'App', resourceUuid: SHARED_APP }] });

/** `staging` and `qa` deploy on land through their own bindings; production `beta` on request. */
function declare(productionTrigger: 'on-land' | 'on-request' = 'on-request') {
  readDocument.mockResolvedValue({
    revision: 1,
    document: projectDoc({
      environments: {
        staging: { tier: 'staging', deployment: deployedBy(STAGING_INT, 'on-land') },
        qa: { tier: 'staging', deployment: deployedBy(SECOND_INT, 'on-land') },
        beta: production({ deployment: deployedBy(PROD_INT, productionTrigger) }),
      },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  selectQueue.length = 0;
  enqueueSpy.mockReset();
  enqueueSpy.mockImplementation(() => undefined);
  findDeliverySpy.mockReset();
  listBindingsSpy.mockReset();
  listBindingsSpy.mockResolvedValue([]);
  acquireLocksMock.mockReset();
  acquireLocksMock.mockImplementation(async (_request, environments) =>
    LOCKS.filter((l) => environments.includes(l.environment)),
  );
  releaseLocksMock.mockReset();
  releaseLocksMock.mockResolvedValue(0);
  openHoldSpy.mockReset();
  openHoldSpy.mockResolvedValue(true);
  abandonHoldSpy.mockReset();
  abandonHoldSpy.mockResolvedValue(undefined);
  heldNow = {};
  declare();
});

describe('tryDispatchCoolifyRelease — the environment hold', () => {
  const envsAsked = () => acquireLocksMock.mock.calls[0]?.[1];
  const subjectAsked = () =>
    (acquireLocksMock.mock.calls[0]?.[0] as { subject: string } | undefined)?.subject;

  it('asks for nothing at all when the caller did not ask for the hold', async () => {
    listBindingsSpy.mockResolvedValue([stagingPair]);

    await tryDispatchCoolifyRelease({ projectId: PROJECT_ID, issueId: ISSUE_ID, runId: RUN_ID });

    expect(acquireLocksMock).not.toHaveBeenCalled();
    expect(releaseLocksMock).not.toHaveBeenCalled();
  });

  it('holds the environments of the bindings it is about to dispatch', async () => {
    listBindingsSpy.mockResolvedValue([stagingPair]);
    heldNow = { 'target:del-a': { status: 'pending' } };

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    expect(envsAsked()).toEqual(['staging']);
    expect(acquireLocksMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });
    expect(subjectAsked()).toContain(STAGING_INT);
    expect(releaseLocksMock).not.toHaveBeenCalled();
  });

  it('holds production for a staging binding that deploys to the production binding’s application', async () => {
    declare('on-land');
    listBindingsSpy.mockResolvedValue([sharedBox(STAGING_INT), sharedBox(PROD_INT)]);
    selectQueue.push([{ status: 'running' }]);

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      integrationId: STAGING_INT,
      takeEnvironmentLock: true,
    });

    expect(envsAsked()).toEqual(['beta', 'staging']);
  });

  it('asks for no hold where there is no binding to dispatch', async () => {
    listBindingsSpy.mockResolvedValue([]);

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
    listBindingsSpy.mockResolvedValue([prodPair]);
    selectQueue.push([{ status: 'running' }]);
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
    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID, BETA_ONLY]]);
  });

  // A hold taken for a binding that then parks is an environment nobody is deploying to — and
  // the confirmation that resumes it asks for that same environment, so leaving it held refuses
  // the press in the name of the very run waiting to make it (ISS-1279).
  it('gives back the environment of a binding that parked, and keeps the one it dispatched', async () => {
    listBindingsSpy.mockResolvedValue([stagingPair, prodPair]);
    selectQueue.push([{ status: 'running' }]);
    selectQueue.push([]); // getProdGateStateForRun: unconfirmed
    selectQueue.push([{ metadata: {} }]); // markPendingHumanConfirm
    heldNow = { 'target:del-a': { status: 'pending', locks: STAGING_ONLY } };

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    expect(outcome.pendingHumanConfirm).toBe(true);
    expect(envsAsked()).toEqual(['beta', 'staging']);
    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID, BETA_ONLY]]);
  });

  // The confirmation that resumes a parked binding deploys THAT binding. Recording the whole
  // fan-out's environments has it ask for a sibling's too, and the press is then refused in the
  // name of the run waiting to make it, for as long as the sibling is still building (ISS-1279).
  it('parks a binding against its own environments, not the whole fan-out\u2019s', async () => {
    listBindingsSpy.mockResolvedValue([stagingPair, prodPair]);
    selectQueue.push([{ status: 'running' }]);
    selectQueue.push([]); // getProdGateStateForRun: unconfirmed
    selectQueue.push([{ metadata: {} }]); // markPendingHumanConfirm

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    const gates = updates
      .map((u) => (u as { metadata?: Record<string, unknown> }).metadata)
      .find((m) => m && '__forge_prod_deploy_gate' in m) as
      | Record<string, Record<string, { lock?: { environments: string[] } }>>
      | undefined;
    expect(gates?.__forge_prod_deploy_gate?.[PROD_INT]?.lock?.environments).toEqual(['beta']);
  });

  it('writes the gate state a parked binding is resumed from', async () => {
    listBindingsSpy.mockResolvedValue([prodPair]);
    selectQueue.push([{ status: 'running' }]);
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
    listBindingsSpy.mockResolvedValue([stagingPair]);
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

    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID, STAGING_ONLY]]);
  });

  // A target that settles between two enqueues reads every hold registered so far as the whole
  // set, closes the run and frees the environment — and the binding not yet reached is then
  // dispatched behind both. Every hold is opened before the first enqueue so that window is shut.
  it('gives the hold back when the binding that was enqueued has already settled', async () => {
    listBindingsSpy.mockResolvedValue([stagingPair, secondPair]);
    enqueueSpy
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('queue is down');
      });
    // The one that WAS enqueued settled before this throw was caught, so nothing of this run is
    // reaching the environment any more — and a count of successful enqueues cannot say so.
    heldNow = { 'target:del-a': { status: 'succeeded', locks: LOCKS } };

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
    listBindingsSpy.mockResolvedValue([stagingPair]);
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
    listBindingsSpy.mockResolvedValue([stagingPair, secondPair]);

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
    listBindingsSpy.mockResolvedValue([stagingPair, secondPair]);

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

  // Attempting a placeholder is not writing one. A run terminal before the fan-out began refuses
  // the first, and claiming its authority for the second would record the very work ISS-922 says
  // a terminal run takes on none of — and then free the environment from half a record.
  it('claims no sibling authority from a placeholder the run refused', async () => {
    listBindingsSpy.mockResolvedValue([stagingPair, secondPair]);
    openHoldSpy.mockResolvedValue(false);

    await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: null,
      runId: RUN_ID,
      takeEnvironmentLock: true,
    });

    const authorised = openHoldSpy.mock.calls.map(
      (c) => (c[0] as { authorisedBySibling?: boolean }).authorisedBySibling,
    );
    expect(authorised).toEqual([false, false]);
  });

  it('gives the hold back when a dispatch hold cannot be opened at all', async () => {
    listBindingsSpy.mockResolvedValue([stagingPair]);
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
    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID, STAGING_ONLY]]);
  });

  it('keeps the hold when the dispatch throws after one binding is already on its way', async () => {
    listBindingsSpy.mockResolvedValue([stagingPair, secondPair]);
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
    listBindingsSpy.mockResolvedValue([stagingPair, secondPair]);
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
