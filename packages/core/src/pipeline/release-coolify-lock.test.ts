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
const releaseLocksMock = vi.fn(async (_runId: string) => 0);
vi.mock('./deploy-lock.js', async () => {
  const real = await vi.importActual<typeof import('./deploy-lock.js')>('./deploy-lock.js');
  return {
    ...real,
    acquireDeployLocks: (request: unknown, environments: readonly string[]) =>
      acquireLocksMock(request, environments),
    releaseDeployLocksForRun: (runId: string) => releaseLocksMock(runId),
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

vi.mock('./deploy-confirmations.js', () => ({
  openDeployDispatchHold: async () => true,
  DEPLOY_CONFIRM_WINDOW_MS: 30 * 60_000,
}));

vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn() },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { confirmPendingProdDeploy, tryDispatchCoolifyRelease } = await import(
  './release-coolify.js'
);
const { DeployEnvironmentLockedError } = await import('./deploy-lock.js');
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
    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID]]);
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

    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID]]);
  });

  it('keeps the hold when the dispatch throws after one binding is already on its way', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair, pairOf(SECOND_INT, ['preview'])]);
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
});

// A release that parked for a human and is confirmed later is the same release
// reaching the same box. A park the landing auto-subscriber opened carries no
// hold and resumes exactly as it always has.
describe('confirmPendingProdDeploy — resuming a parked release', () => {
  const GATE_KEY = '__forge_prod_deploy_gate';
  const lockIntent = {
    projectId: PROJECT_ID,
    environments: ['live'],
    subject: `live deploy (binding ${PROD_INT})`,
  };

  const queueGate = (gate: Record<string, unknown>) => {
    const metadata = { [GATE_KEY]: { [PROD_INT]: gate } };
    selectQueue.push([{ id: RUN_ID, metadata }]); // getProdGateState scan
    selectQueue.push([{ id: RUN_ID, metadata }]); // the run itself
  };

  const parkedGate = (over: Record<string, unknown> = {}) => ({
    runId: RUN_ID,
    issueId: null,
    bindingId: PROD_INT,
    requestedAt: new Date().toISOString(),
    confirmedAt: null,
    ...over,
  });

  const heldElsewhere = () =>
    new DeployEnvironmentLockedError('live', {
      projectId: PROJECT_ID,
      environment: 'live',
      runId: 'some-other-run',
      subject: 'live deploy (binding x)',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    });

  it('refuses the confirmation while another run holds the environment', async () => {
    queueGate(parkedGate({ lock: lockIntent }));
    findDeliverySpy.mockResolvedValueOnce(null);
    acquireLocksMock.mockRejectedValueOnce(heldElsewhere());

    await expect(confirmPendingProdDeploy(PROD_INT)).rejects.toThrow(/DEPLOY_ENVIRONMENT_LOCKED/);

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('leaves the gate unconfirmed when it refuses, so a human can press it again', async () => {
    queueGate(parkedGate({ lock: lockIntent }));
    findDeliverySpy.mockResolvedValueOnce(null);
    acquireLocksMock.mockRejectedValueOnce(heldElsewhere());

    await confirmPendingProdDeploy(PROD_INT).catch(() => undefined);

    expect(db.update).not.toHaveBeenCalled();
  });

  it('enqueues once the environment is free', async () => {
    queueGate(parkedGate({ lock: lockIntent }));
    findDeliverySpy.mockResolvedValueOnce(null);

    const result = await confirmPendingProdDeploy(PROD_INT);

    expect(acquireLocksMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      subject: lockIntent.subject,
    });
    expect(acquireLocksMock.mock.calls[0]?.[1]).toEqual(['live']);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ confirmed: true, runId: RUN_ID, integrationId: PROD_INT });
  });

  it('takes no hold for a park that never held one', async () => {
    queueGate(parkedGate());
    findDeliverySpy.mockResolvedValueOnce(null);

    await confirmPendingProdDeploy(PROD_INT);

    expect(acquireLocksMock).not.toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it('asks for no hold on a confirmation that was already enqueued', async () => {
    queueGate(parkedGate({ lock: lockIntent }));
    findDeliverySpy.mockResolvedValueOnce({ id: 'already-there' });

    await confirmPendingProdDeploy(PROD_INT);

    expect(acquireLocksMock).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
