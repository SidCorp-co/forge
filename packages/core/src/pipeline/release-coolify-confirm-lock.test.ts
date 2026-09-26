/**
 * ISS-1279 — the environment hold across the human confirmation that resumes a parked release.
 * The hold is taken BEFORE the gate flips, so a refused confirmation can be pressed again, and
 * given back where nothing was enqueued in its name.
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

const { confirmPendingProdDeploy } = await import('./release-coolify.js');
const { DeployEnvironmentLockedError } = await import('./deploy-lock.js');
const { db } = await import('../db/client.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'run-1';
const PROD_INT = 'b2222222-2222-4222-8222-222222222222';

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

  it('gives the hold back when the confirmation fails before anything is enqueued', async () => {
    queueGate(parkedGate({ lock: lockIntent }));
    findDeliverySpy.mockResolvedValueOnce(null);
    enqueueSpy.mockImplementation(() => {
      throw new Error('queue is down');
    });

    await expect(confirmPendingProdDeploy(PROD_INT)).rejects.toThrow('queue is down');

    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID, LIVE_ONLY]]);
  });

  it('asks for no hold on a confirmation that was already enqueued', async () => {
    queueGate(parkedGate({ lock: lockIntent }));
    findDeliverySpy.mockResolvedValueOnce({ id: 'already-there' });

    await confirmPendingProdDeploy(PROD_INT);

    expect(acquireLocksMock).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
