/**
 * ISS-1279 — the environment a dispatch no longer needs goes back on the record of what that
 * dispatch authorised, and that record is written whatever ended the fan-out. Both halves are one
 * rule: the bookkeeping is the only thing that knows what Coolify was asked to do.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findConnectionByIdMock = vi.fn();
vi.mock('../store.js', () => ({
  updateConnection: vi.fn(async () => ({})),
  findConnectionById: (...a: unknown[]) => findConnectionByIdMock(...(a as [])),
  buildContextFromBinding: vi.fn(),
}));
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../../db/client.js', () => ({ db: {} }));
const recordDeliveryMock = vi.fn();
vi.mock('../deliveries.js', () => ({
  recordDelivery: (...a: unknown[]) => recordDeliveryMock(...(a as [])),
  updateDelivery: vi.fn(),
}));
const replaceHoldsMock = vi.fn(async (_args: unknown) => true);
/** What `readDeployHolds` finds once the dispatch has written its holds. */
let heldNow: Record<string, { status: string }> = {};
vi.mock('../../pipeline/deploy-confirmations.js', () => ({
  DEPLOY_CONFIRM_WINDOW_MS: 1_800_000,
  replaceDispatchHoldWithTargets: (args: unknown) => replaceHoldsMock(args),
  readDeployHolds: async () => heldNow,
}));
const releaseLocksMock = vi.fn(async (_runId: string) => 0);
vi.mock('../../pipeline/deploy-lock.js', async () => {
  const real = await vi.importActual<typeof import('../../pipeline/deploy-lock.js')>(
    '../../pipeline/deploy-lock.js',
  );
  return { ...real, releaseDeployLocksForRun: (runId: string) => releaseLocksMock(runId) };
});
const enqueueConfirmMock = vi.fn();
vi.mock('./confirm.js', () => ({
  enqueueCoolifyConfirm: (...a: unknown[]) => enqueueConfirmMock(...(a as [])),
}));
vi.mock('./circuit-breaker.js', () => ({
  maybeTripBreaker: vi.fn(),
  maybeResetBreaker: vi.fn(),
  breakerAllowsDispatch: vi.fn(async () => ({ allow: true, halfOpen: false })),
}));
vi.mock('../../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn(), captureMessage: vi.fn() },
}));

const { coolifyAdapter } = await import('./adapter.js');

const CONN_ID = 'conn-cf-1';

function twoTargetCtx() {
  return {
    projectId: '33333333-3333-4333-8333-333333333333',
    connectionId: CONN_ID,
    bindingId: 'bind-cf-1',
    environment: 'staging',
    config: {
      baseUrl: 'https://coolify.example',
      targets: [
        { id: 't-be', label: 'Backend', resourceUuid: 'res-be' },
        { id: 't-fe', label: 'Frontend', resourceUuid: 'res-fe' },
      ],
    },
    secrets: { apiToken: 'cf' },
    // biome-ignore lint/suspicious/noExplicitAny: adapter ctx generics resolved at registration
  } as any;
}

describe('coolifyAdapter.dispatchOutbound — the environment the dispatch no longer needs', () => {
  const RUN_ID = 'run-lock-1';

  beforeEach(() => {
    findConnectionByIdMock.mockResolvedValue({ id: CONN_ID, active: true });
    recordDeliveryMock.mockImplementation(
      async () => `del-${recordDeliveryMock.mock.calls.length}`,
    );
  });

  it('frees the environment when every target was refused a deployment', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;
    heldNow = { 'target:del-1': { status: 'failed' }, 'target:del-2': { status: 'failed' } };

    await expect(
      coolifyAdapter.dispatchOutbound(twoTargetCtx(), {
        eventName: 'release.requested',
        payload: { runId: RUN_ID },
        requestId: 'req-f',
      }),
    ).rejects.toThrow(/coolify deploy failed for 2\/2/);

    expect(releaseLocksMock.mock.calls).toEqual([[RUN_ID]]);
  });

  it('holds the environment while one of the two is still building', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return n === 1
        ? new Response(JSON.stringify({ deployment_uuid: 'dep-1' }), { status: 200 })
        : new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;
    heldNow = { 'target:del-1': { status: 'pending' }, 'target:del-2': { status: 'failed' } };

    await expect(
      coolifyAdapter.dispatchOutbound(twoTargetCtx(), {
        eventName: 'release.requested',
        payload: { runId: RUN_ID },
        requestId: 'req-p',
      }),
    ).rejects.toThrow(/coolify deploy failed for 1\/2/);

    expect(releaseLocksMock).not.toHaveBeenCalled();
  });

  // A refused hold is not an idle environment: the run recorded nothing, so what Coolify is
  // running is unknown and only the expiry may end the hold.
  it('frees nothing when the run refused the holds, however idle the record reads', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;
    replaceHoldsMock.mockResolvedValueOnce(false);
    // Resolved, so the record reads idle — and it is a record of an EARLIER deploy, not of the
    // two this dispatch just sent Coolify and could record nothing about.
    heldNow = { 'target:del-earlier': { status: 'succeeded' } };

    await expect(
      coolifyAdapter.dispatchOutbound(twoTargetCtx(), {
        eventName: 'release.requested',
        payload: { runId: RUN_ID },
        requestId: 'req-u',
      }),
    ).rejects.toThrow(/coolify deploy failed/);

    expect(releaseLocksMock).not.toHaveBeenCalled();
  });

  // A sibling target that throws leaves Coolify building what it already accepted, with the
  // delivery row refusing a second dispatch: the bookkeeping is all that can ask how it went.
  it('records and polls what Coolify accepted even when the fan-out throws partway', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ deployment_uuid: 'dep-1' }), { status: 200 }),
    ) as unknown as typeof fetch;
    recordDeliveryMock
      .mockImplementationOnce(async () => 'del-1')
      .mockImplementationOnce(async () => {
        throw new Error('delivery row refused');
      });

    await expect(
      coolifyAdapter.dispatchOutbound(twoTargetCtx(), {
        eventName: 'release.requested',
        payload: { runId: RUN_ID },
        requestId: 'req-t',
      }),
    ).rejects.toThrow('delivery row refused');

    expect(enqueueConfirmMock).toHaveBeenCalledTimes(1);
    const args = replaceHoldsMock.mock.calls[0]?.[0] as { targets: { deliveryId: string }[] };
    expect(args.targets).toEqual([expect.objectContaining({ deliveryId: 'del-1' })]);
  });
});
