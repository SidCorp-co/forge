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
const findOutboundMock = vi.fn();
const listDispatchedMock = vi.fn();
const findInboundMock = vi.fn();
vi.mock('../deliveries.js', () => ({
  recordDelivery: (...a: unknown[]) => recordDeliveryMock(...(a as [])),
  updateDelivery: vi.fn(),
  findOutboundByDeploymentUuid: (...a: unknown[]) => findOutboundMock(...(a as [])),
  listDispatchedOutboundForRun: (...a: unknown[]) => listDispatchedMock(...(a as [])),
  findInboundByDeploymentUuid: (...a: unknown[]) => findInboundMock(...(a as [])),
}));
const closeRunMock = vi.fn();
const setCurrentStepForceMock = vi.fn();
vi.mock('../../pipeline/runs.js', () => ({
  closeRun: (...a: unknown[]) => closeRunMock(...(a as [])),
  setCurrentStepForce: (...a: unknown[]) => setCurrentStepForceMock(...(a as [])),
}));
vi.mock('../../webhooks/hmac.js', () => ({ verifyHmacSignature: () => true }));
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

describe('coolifyAdapter.handleInbound — multi-target run aggregation', () => {
  const RUN_ID = 'run-multi-1';

  function inboundCtx() {
    return {
      projectId: PROJECT_ID,
      connectionId: CONN_ID,
      bindingId: BINDING_ID,
      environment: 'staging',
      integrationSecret: 'whsec_test',
      config: { baseUrl: 'https://coolify.example', targets: [] },
      secrets: {},
      // biome-ignore lint/suspicious/noExplicitAny: adapter ctx generics resolved at registration
    } as any;
  }

  function webhook(deploymentUuid: string, status: 'success' | 'failed') {
    const body = JSON.stringify({
      event: `deploy.${status === 'success' ? 'succeeded' : 'failed'}`,
      deployment_uuid: deploymentUuid,
      status,
    });
    return {
      headers: { 'x-coolify-signature-256': 'sha256=x' },
      rawBody: body,
      payload: JSON.parse(body),
    };
  }

  beforeEach(() => {
    recordDeliveryMock.mockResolvedValue('inb-1');
    // The webhook's deployment maps back to its outbound delivery → run.
    findOutboundMock.mockResolvedValue({ payload: { runId: RUN_ID } });
    // Two targets dispatched for this run.
    listDispatchedMock.mockResolvedValue([
      { response: { deployment_uuid: 'dep-be' } },
      { response: { deployment_uuid: 'dep-fe' } },
    ]);
  });

  it('does NOT close the run until every target reports success (1/2)', async () => {
    // Only the BE target has a successful inbound so far.
    findInboundMock.mockImplementation(async (_bid: string, uuid: string) =>
      uuid === 'dep-be' ? { payload: { status: 'success' } } : null,
    );

    const res = await coolifyAdapter.handleInbound(inboundCtx(), webhook('dep-be', 'success'));

    expect(res.actions).toBe(1);
    expect(setCurrentStepForceMock).toHaveBeenCalledWith(RUN_ID, 'release.deploy.in_flight (1/2)');
    expect(closeRunMock).not.toHaveBeenCalled();
  });

  it('closes the run completed once all targets succeeded (2/2)', async () => {
    findInboundMock.mockResolvedValue({ payload: { status: 'success' } });

    await coolifyAdapter.handleInbound(inboundCtx(), webhook('dep-fe', 'success'));

    expect(setCurrentStepForceMock).toHaveBeenCalledWith(RUN_ID, 'release.deploy.done');
    expect(closeRunMock).toHaveBeenCalledWith(RUN_ID, 'completed');
  });

  it('fails the run fast on any target failure', async () => {
    await coolifyAdapter.handleInbound(inboundCtx(), webhook('dep-be', 'failed'));

    expect(setCurrentStepForceMock).toHaveBeenCalledWith(RUN_ID, 'release.deploy.failed');
    expect(closeRunMock).toHaveBeenCalledWith(RUN_ID, 'failed');
    // Fail-fast: no need to scan siblings.
    expect(listDispatchedMock).not.toHaveBeenCalled();
  });
});
