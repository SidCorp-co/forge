import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConnectionMock = vi.fn();
const findConnectionByIdMock = vi.fn();
vi.mock('../store.js', () => ({
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
  findConnectionById: (...a: unknown[]) => findConnectionByIdMock(...(a as [])),
  buildContextFromBinding: vi.fn(),
}));

// Stub the modules whose import chains pull in the db client / env (not needed
// for the healthcheck path) so this suite runs without a configured database.
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../../db/client.js', () => ({ db: {} }));
const recordDeliveryMock = vi.fn();
vi.mock('../deliveries.js', () => ({
  recordDelivery: (...a: unknown[]) => recordDeliveryMock(...(a as [])),
  updateDelivery: vi.fn(),
}));
const replaceHoldsMock = vi.fn();
vi.mock('../../pipeline/deploy-confirmations.js', () => ({
  DEPLOY_CONFIRM_WINDOW_MS: 1_800_000,
  replaceDispatchHoldWithTargets: (...a: unknown[]) => replaceHoldsMock(...(a as [])),
}));
const enqueueConfirmMock = vi.fn();
vi.mock('./confirm.js', () => ({
  enqueueCoolifyConfirm: (...a: unknown[]) => enqueueConfirmMock(...(a as [])),
}));
const breakerAllowsDispatchMock = vi.fn(async () => ({ allow: true, halfOpen: false }));
const maybeResetBreakerMock = vi.fn();
vi.mock('./circuit-breaker.js', () => ({
  maybeTripBreaker: vi.fn(),
  maybeResetBreaker: (...a: unknown[]) => maybeResetBreakerMock(...(a as [])),
  breakerAllowsDispatch: (...a: unknown[]) => breakerAllowsDispatchMock(...(a as [])),
}));
vi.mock('../../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn(), captureMessage: vi.fn() },
}));

const { coolifyAdapter } = await import('./adapter.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const CONN_ID = 'conn-cf-1';
const BINDING_ID = 'bind-cf-1';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
  updateConnectionMock.mockReset();
});

beforeEach(() => {
  updateConnectionMock.mockResolvedValue({});
});

function buildCtx(secrets: Record<string, unknown>) {
  return {
    projectId: PROJECT_ID,
    connectionId: CONN_ID,
    bindingId: BINDING_ID,
    environment: 'staging',
    config: {
      baseUrl: 'https://coolify.example',
      targets: [{ id: 't-1', label: 'App', resourceUuid: 'res-1' }],
    },
    secrets,
    // biome-ignore lint/suspicious/noExplicitAny: adapter ctx generics resolved at registration
  } as any;
}

describe('coolifyAdapter.healthcheck — needs_reauth on rejected token (ISS-409)', () => {
  it('surfaces needs_reauth when the API token is rejected (401)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    const res = await coolifyAdapter.healthcheck(buildCtx({ apiToken: 'cf-current' }));

    expect(res.status).toBe('needs_reauth');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('surfaces needs_reauth on a 403 (forbidden token)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch;

    const res = await coolifyAdapter.healthcheck(buildCtx({ apiToken: 'cf-current' }));

    expect(res.status).toBe('needs_reauth');
  });

  it('resets the breaker on a successful Test-connection (operator recovery)', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([{ uuid: 'res-1', name: 'App', status: 'running' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const res = await coolifyAdapter.healthcheck(buildCtx({ apiToken: 'cf-current' }));

    expect(res.status).toBe('ok');
    expect(maybeResetBreakerMock).toHaveBeenCalledWith(CONN_ID);
  });

  it('keeps error for a non-auth HTTP failure (500)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    const res = await coolifyAdapter.healthcheck(buildCtx({ apiToken: 'cf-current' }));

    expect(res.status).toBe('error');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'error' }),
    );
  });
});

describe('coolifyAdapter.dispatchOutbound — health follows real deploy outcomes (ISS-429)', () => {
  it('records lastHealthStatus=ok on a successful deploy dispatch', async () => {
    findConnectionByIdMock.mockResolvedValue({ id: CONN_ID, active: true });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ deployments: [{ deployment_uuid: 'dep-1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const res = await coolifyAdapter.dispatchOutbound(buildCtx({ apiToken: 'cf-current' }), {
      eventName: 'release.requested',
      payload: { runId: 'run-1' },
    });

    expect(res.externalId).toBe('dep-1');
    // The stale-error fix: a working deploy path must flip health back to ok
    // instead of leaving a months-old error from a one-off healthcheck.
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'ok' }),
    );
  });

  it('does not write ok health when the deploy dispatch fails', async () => {
    findConnectionByIdMock.mockResolvedValue({ id: CONN_ID, active: true });
    globalThis.fetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(
      coolifyAdapter.dispatchOutbound(buildCtx({ apiToken: 'cf-current' }), {
        eventName: 'release.requested',
        payload: { runId: 'run-1' },
      }),
    ).rejects.toThrow();

    expect(updateConnectionMock).not.toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'ok' }),
    );
  });
});

describe('coolifyAdapter — the deploy is held until Coolify confirms it (ISS-922)', () => {
  const RUN_ID = 'run-multi-1';

  function twoTargetCtx() {
    return {
      projectId: PROJECT_ID,
      connectionId: CONN_ID,
      bindingId: BINDING_ID,
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

  beforeEach(() => {
    findConnectionByIdMock.mockResolvedValue({ id: CONN_ID, active: true });
    recordDeliveryMock.mockImplementation(
      async () => `del-${recordDeliveryMock.mock.calls.length}`,
    );
  });

  it('opens one hold per target and one confirmation poll per deployment', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return new Response(JSON.stringify({ deployment_uuid: `dep-${n}` }), { status: 200 });
    }) as unknown as typeof fetch;

    await coolifyAdapter.dispatchOutbound(twoTargetCtx(), {
      eventName: 'release.requested',
      payload: { runId: RUN_ID },
      requestId: 'req-1',
    });

    expect(enqueueConfirmMock).toHaveBeenCalledTimes(2);
    expect(replaceHoldsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        requestId: 'req-1',
        targets: [
          expect.objectContaining({
            targetLabel: 'Backend',
            deploymentUuid: 'dep-1',
            status: 'pending',
          }),
          expect.objectContaining({
            targetLabel: 'Frontend',
            deploymentUuid: 'dep-2',
            status: 'pending',
          }),
        ],
      }),
    );
  });

  it('a target that never got a deployment_uuid is already a FAILED hold, not a pending one', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return n === 1
        ? new Response(JSON.stringify({ deployment_uuid: 'dep-be' }), { status: 200 })
        : new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;

    await expect(
      coolifyAdapter.dispatchOutbound(twoTargetCtx(), {
        eventName: 'release.requested',
        payload: { runId: RUN_ID },
        requestId: 'req-2',
      }),
    ).rejects.toThrow(/coolify deploy failed for 1\/2/);

    const holds = replaceHoldsMock.mock.calls[0]?.[0] as {
      targets: { targetLabel: string; status: string }[];
    };
    expect(holds.targets).toEqual([
      expect.objectContaining({ targetLabel: 'Backend', status: 'pending' }),
      expect.objectContaining({ targetLabel: 'Frontend', status: 'failed' }),
    ]);
  });

  it('handleInbound REFUSES by name rather than accepting a body it cannot have verified', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: refusal takes no meaningful args
      (coolifyAdapter as any).handleInbound(),
    ).rejects.toThrow(/inbound webhooks are not supported/);
  });
});
