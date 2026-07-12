/**
 * ISS-242 — dispatch-level tests for the shared Coolify release path.
 *
 * Covers the two behaviours the `forge_coolify_deploy → deploy` tool relies on
 * but cannot prove on its own (it mocks this module):
 *  - staging deploy enqueues exactly once, and a re-dispatch for the same
 *    `requestId` is skipped by the `findDeliveryByRequestId` idempotency guard
 *    (manual + auto never double-deploy);
 *  - a prod integration with an unconfirmed gate returns `pendingHumanConfirm`
 *    and enqueues nothing.
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

const enqueueSpy = vi.fn();
vi.mock('../integrations/queue.js', () => ({
  enqueueCoolifyDispatch: (job: unknown) => enqueueSpy(job),
}));

const findDeliverySpy = vi.fn();
vi.mock('../integrations/deliveries.js', () => ({
  findDeliveryByRequestId: (id: string, req: string) => findDeliverySpy(id, req),
}));

// Coolify integration resolution now goes through the binding→connection store
// helper; pipelineRuns reads/writes still use the db stub above.
const listBindingsSpy = vi.fn();
vi.mock('../integrations/store.js', () => ({
  listActiveBindingsForProjectProvider: (...a: unknown[]) => listBindingsSpy(...(a as [])),
}));

vi.mock('./runs.js', () => ({ setCurrentStepForce: vi.fn() }));

vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn() },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { tryDispatchCoolifyRelease, dispatchCoolifyDeployDirect, isIssueAtReleaseStage } =
  await import('./release-coolify.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = 'run-1';
const STAGING_INT = 'a1111111-1111-4111-8111-111111111111';
const PROD_INT = 'b2222222-2222-4222-8222-222222222222';

const stagingPair = {
  binding: {
    id: STAGING_INT,
    projectId: PROJECT_ID,
    provider: 'coolify',
    environment: 'staging',
    config: {},
    active: true,
  },
  connection: { id: STAGING_INT, provider: 'coolify', config: {}, active: true },
};
const prodPair = {
  binding: {
    id: PROD_INT,
    projectId: PROJECT_ID,
    provider: 'coolify',
    environment: 'prod',
    config: {},
    active: true,
  },
  connection: { id: PROD_INT, provider: 'coolify', config: {}, active: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  enqueueSpy.mockReset();
  findDeliverySpy.mockReset();
  listBindingsSpy.mockReset();
  listBindingsSpy.mockResolvedValue([]);
});

describe('tryDispatchCoolifyRelease — staging dispatch', () => {
  it('always enqueues a fresh dispatch with a per-attempt requestId (no dedup block)', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair]); // active coolify bindings

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
    });

    // No idempotency lookup — re-deploys are never silently no-op'd (ISS-290).
    expect(findDeliverySpy).not.toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const job = enqueueSpy.mock.calls[0]?.[0] as { bindingId: string; requestId: string };
    expect(job.bindingId).toBe(STAGING_INT);
    expect(job.requestId).toMatch(new RegExp(`^${RUN_ID}:${STAGING_INT}:\\d+-[0-9a-f]{8}$`));
    expect(outcome.dispatched).toBe(true);
    expect(outcome.integrationIds).toEqual([STAGING_INT]);
  });

  it('re-deploying the same run enqueues again with a distinct requestId', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair]);
    await tryDispatchCoolifyRelease({ projectId: PROJECT_ID, issueId: ISSUE_ID, runId: RUN_ID });
    listBindingsSpy.mockResolvedValueOnce([stagingPair]);
    await tryDispatchCoolifyRelease({ projectId: PROJECT_ID, issueId: ISSUE_ID, runId: RUN_ID });

    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    const r1 = (enqueueSpy.mock.calls[0]?.[0] as { requestId: string }).requestId;
    const r2 = (enqueueSpy.mock.calls[1]?.[0] as { requestId: string }).requestId;
    expect(r1).not.toBe(r2);
  });
});

describe('dispatchCoolifyDeployDirect — run-less resource redeploy (ISS-312)', () => {
  it('staging: enqueues with runId:null + a synthetic direct: requestId', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair]); // active coolify bindings

    const outcome = await dispatchCoolifyDeployDirect({
      projectId: PROJECT_ID,
      integrationId: STAGING_INT,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const job = enqueueSpy.mock.calls[0]?.[0] as {
      bindingId: string;
      runId: string | null;
      issueId: string | null;
      requestId: string;
    };
    expect(job.bindingId).toBe(STAGING_INT);
    expect(job.runId).toBeNull();
    expect(job.issueId).toBeNull();
    expect(job.requestId).toMatch(new RegExp(`^direct:${STAGING_INT}:\\d+-[0-9a-f]{8}$`));
    expect(outcome.dispatched).toBe(true);
    expect(outcome.pendingHumanConfirm).toBe(false);
    expect(outcome.integrationIds).toEqual([STAGING_INT]);
  });

  it('prod: returns pendingHumanConfirm and enqueues nothing', async () => {
    listBindingsSpy.mockResolvedValueOnce([prodPair]);

    const outcome = await dispatchCoolifyDeployDirect({
      projectId: PROJECT_ID,
      integrationId: PROD_INT,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
    expect(outcome.pendingHumanConfirm).toBe(true);
    expect(outcome.integrationIds).toEqual([PROD_INT]);
    expect(outcome.reason).toBe('awaiting-prod-confirm');
  });

  it('unknown/inactive integration: returns no-integration without enqueueing', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair]); // active set does not include the requested id

    const outcome = await dispatchCoolifyDeployDirect({
      projectId: PROJECT_ID,
      integrationId: PROD_INT,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
    expect(outcome.integrationIds).toEqual([]);
    expect(outcome.reason).toBe('no-integration');
  });
});

describe('tryDispatchCoolifyRelease — prod autoProdDeploy bypass', () => {
  it('auto-dispatches prod like staging when the project opted into autoProdDeploy', async () => {
    listBindingsSpy.mockResolvedValueOnce([prodPair]);
    // projectAutoProdDeploy read → flag on → skip the gate entirely.
    selectQueue.push([{ agentConfig: { pipelineConfig: { autoProdDeploy: true } } }]);

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const job = enqueueSpy.mock.calls[0]?.[0] as { bindingId: string };
    expect(job.bindingId).toBe(PROD_INT);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.pendingHumanConfirm).toBe(false);
    expect(outcome.integrationIds).toEqual([PROD_INT]);
  });

  it('run-less prod also auto-dispatches when autoProdDeploy is on', async () => {
    listBindingsSpy.mockResolvedValueOnce([prodPair]);
    selectQueue.push([{ agentConfig: { pipelineConfig: { autoProdDeploy: true } } }]);

    const outcome = await dispatchCoolifyDeployDirect({
      projectId: PROJECT_ID,
      integrationId: PROD_INT,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const job = enqueueSpy.mock.calls[0]?.[0] as { runId: string | null; requestId: string };
    expect(job.runId).toBeNull();
    expect(job.requestId).toMatch(new RegExp(`^direct:${PROD_INT}:\\d+-[0-9a-f]{8}$`));
    expect(outcome.dispatched).toBe(true);
    expect(outcome.pendingHumanConfirm).toBe(false);
  });
});

describe('tryDispatchCoolifyRelease — integrationId hard filter + allowProd', () => {
  it('integrationId filters to only that binding — prod is never touched', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair, prodPair]);

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
      integrationId: STAGING_INT,
      allowProd: true,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const job = enqueueSpy.mock.calls[0]?.[0] as { bindingId: string };
    expect(job.bindingId).toBe(STAGING_INT);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.integrationIds).toEqual([STAGING_INT]);
  });

  it('allowProd:false excludes prod bindings entirely — no enqueue, no gate', async () => {
    listBindingsSpy.mockResolvedValueOnce([stagingPair, prodPair]);

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
      allowProd: false,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const job = enqueueSpy.mock.calls[0]?.[0] as { bindingId: string };
    expect(job.bindingId).toBe(STAGING_INT);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.pendingHumanConfirm).toBe(false);
    expect(outcome.integrationIds).toEqual([STAGING_INT]);
  });

  it('no new args (auto-subscriber shape): prod still auto-dispatches under autoProdDeploy — unchanged', async () => {
    listBindingsSpy.mockResolvedValueOnce([prodPair]);
    selectQueue.push([{ agentConfig: { pipelineConfig: { autoProdDeploy: true } } }]);

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const job = enqueueSpy.mock.calls[0]?.[0] as { bindingId: string };
    expect(job.bindingId).toBe(PROD_INT);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.integrationIds).toEqual([PROD_INT]);
  });
});

describe('isIssueAtReleaseStage', () => {
  it('returns true for released', async () => {
    selectQueue.push([{ status: 'released' }]);
    await expect(isIssueAtReleaseStage(ISSUE_ID)).resolves.toBe(true);
  });

  it('returns true for closed', async () => {
    selectQueue.push([{ status: 'closed' }]);
    await expect(isIssueAtReleaseStage(ISSUE_ID)).resolves.toBe(true);
  });

  it('returns false for a pre-release status', async () => {
    selectQueue.push([{ status: 'testing' }]);
    await expect(isIssueAtReleaseStage(ISSUE_ID)).resolves.toBe(false);
  });
});

describe('tryDispatchCoolifyRelease — prod confirm gate', () => {
  it('returns pendingHumanConfirm and enqueues nothing when the gate is unconfirmed', async () => {
    listBindingsSpy.mockResolvedValueOnce([prodPair]); // active coolify bindings
    selectQueue.push([]); // projectAutoProdDeploy: no agentConfig → gate stays on
    selectQueue.push([]); // getProdGateState: no run carries a gate
    selectQueue.push([{ metadata: {} }]); // markPendingHumanConfirm: run metadata read

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(findDeliverySpy).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
    expect(outcome.pendingHumanConfirm).toBe(true);
    expect(outcome.integrationIds).toEqual([PROD_INT]);
  });
});
