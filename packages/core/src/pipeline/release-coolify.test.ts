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

vi.mock('./runs.js', () => ({ setCurrentStepForce: vi.fn() }));

vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn() },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { tryDispatchCoolifyRelease, dispatchCoolifyDeployDirect } = await import(
  './release-coolify.js'
);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = 'run-1';
const STAGING_INT = 'a1111111-1111-4111-8111-111111111111';
const PROD_INT = 'b2222222-2222-4222-8222-222222222222';

const stagingRow = { id: STAGING_INT, environment: 'staging' };
const prodRow = { id: PROD_INT, environment: 'prod' };

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  enqueueSpy.mockReset();
  findDeliverySpy.mockReset();
});

describe('tryDispatchCoolifyRelease — staging dispatch', () => {
  it('always enqueues a fresh dispatch with a per-attempt requestId (no dedup block)', async () => {
    selectQueue.push([stagingRow]); // active coolify integrations

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
    });

    // No idempotency lookup — re-deploys are never silently no-op'd (ISS-290).
    expect(findDeliverySpy).not.toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const job = enqueueSpy.mock.calls[0]?.[0] as { integrationId: string; requestId: string };
    expect(job.integrationId).toBe(STAGING_INT);
    expect(job.requestId).toMatch(new RegExp(`^${RUN_ID}:${STAGING_INT}:\\d+-[0-9a-f]{8}$`));
    expect(outcome.dispatched).toBe(true);
    expect(outcome.integrationIds).toEqual([STAGING_INT]);
  });

  it('re-deploying the same run enqueues again with a distinct requestId', async () => {
    selectQueue.push([stagingRow]);
    await tryDispatchCoolifyRelease({ projectId: PROJECT_ID, issueId: ISSUE_ID, runId: RUN_ID });
    selectQueue.push([stagingRow]);
    await tryDispatchCoolifyRelease({ projectId: PROJECT_ID, issueId: ISSUE_ID, runId: RUN_ID });

    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    const r1 = (enqueueSpy.mock.calls[0]?.[0] as { requestId: string }).requestId;
    const r2 = (enqueueSpy.mock.calls[1]?.[0] as { requestId: string }).requestId;
    expect(r1).not.toBe(r2);
  });
});

describe('dispatchCoolifyDeployDirect — run-less resource redeploy (ISS-312)', () => {
  it('staging: enqueues with runId:null + a synthetic direct: requestId', async () => {
    selectQueue.push([stagingRow]); // active coolify integrations

    const outcome = await dispatchCoolifyDeployDirect({
      projectId: PROJECT_ID,
      integrationId: STAGING_INT,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const job = enqueueSpy.mock.calls[0]?.[0] as {
      integrationId: string;
      runId: string | null;
      issueId: string | null;
      requestId: string;
    };
    expect(job.integrationId).toBe(STAGING_INT);
    expect(job.runId).toBeNull();
    expect(job.issueId).toBeNull();
    expect(job.requestId).toMatch(new RegExp(`^direct:${STAGING_INT}:\\d+-[0-9a-f]{8}$`));
    expect(outcome.dispatched).toBe(true);
    expect(outcome.pendingHumanConfirm).toBe(false);
    expect(outcome.integrationIds).toEqual([STAGING_INT]);
  });

  it('prod: returns pendingHumanConfirm and enqueues nothing', async () => {
    selectQueue.push([prodRow]);

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
    selectQueue.push([stagingRow]); // active set does not include the requested id

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

describe('tryDispatchCoolifyRelease — prod confirm gate', () => {
  it('returns pendingHumanConfirm and enqueues nothing when the gate is unconfirmed', async () => {
    selectQueue.push([prodRow]); // active coolify integrations
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
