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

const { tryDispatchCoolifyRelease } = await import('./release-coolify.js');

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

describe('tryDispatchCoolifyRelease — staging idempotency', () => {
  it('enqueues exactly one dispatch with requestId=runId:integrationId', async () => {
    selectQueue.push([stagingRow]); // active coolify integrations
    findDeliverySpy.mockResolvedValueOnce(null); // no prior delivery

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: STAGING_INT, requestId: `${RUN_ID}:${STAGING_INT}` }),
    );
    expect(outcome.dispatched).toBe(true);
    expect(outcome.integrationIds).toEqual([STAGING_INT]);
  });

  it('skips re-enqueue when a delivery already exists for the requestId', async () => {
    selectQueue.push([stagingRow]);
    findDeliverySpy.mockResolvedValueOnce({ id: 'delivery-1' }); // already dispatched

    const outcome = await tryDispatchCoolifyRelease({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: RUN_ID,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
    // Still reported as dispatched so the caller treats it as a no-op success.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.integrationIds).toEqual([STAGING_INT]);
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
