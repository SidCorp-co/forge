import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConnectionMock = vi.fn();
const findConnectionByIdMock = vi.fn();
vi.mock('../store.js', () => ({
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
  findConnectionById: (...a: unknown[]) => findConnectionByIdMock(...(a as [])),
  buildContextFromBinding: vi.fn(),
}));

// cm:why the db client and env are stubbed because the adapter's import chain reaches both, not because this suite uses them — the healthcheck path under test touches neither.
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../../db/client.js', () => ({ db: {} }));
const recordDeliveryMock = vi.fn();
vi.mock('../deliveries.js', () => ({
  recordDelivery: (...a: unknown[]) => recordDeliveryMock(...(a as [])),
  updateDelivery: vi.fn(),
}));
const replaceHoldsMock = vi.fn(async (_args: unknown) => true);
vi.mock('../../pipeline/deploy-confirmations.js', () => ({
  DEPLOY_CONFIRM_WINDOW_MS: 1_800_000,
  replaceDispatchHoldWithTargets: (args: unknown) => replaceHoldsMock(args),
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
const { logger } = await import('../../logger.js');

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

describe('coolifyAdapter.healthcheck — 401 and 403 are different verdicts (ISS-409/ISS-924)', () => {
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

  it('surfaces needs_scope on a 403, naming the missing ability and the route', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch;

    const res = await coolifyAdapter.healthcheck(buildCtx({ apiToken: 'cf-current' }));

    expect(res.status).toBe('needs_scope');
    expect(res.message).toContain('api.ability:read');
    expect(res.message).toContain('GET /api/v1/resources');
    // cm:guard this negative assertion IS the issue — a 403 message that tells the operator to re-enter or replace the credential sends them to redo work that reproduces the state exactly (ISS-924)
    expect(res.message).not.toMatch(/re-enter|replace it/);
    expect(res.diagnostics).toMatchObject({
      httpStatus: 403,
      route: 'GET /api/v1/resources',
      missingAbility: 'read',
    });
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_scope' }),
    );
  });

  it('leaves a non-auth failure on error', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    const res = await coolifyAdapter.healthcheck(buildCtx({ apiToken: 'cf-current' }));

    expect(res.status).toBe('error');
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
    // cm:guard a succeeding deploy is itself proof the API is reachable and the token accepted, so it must clear health back to ok — without this the card stays on a months-old `error` from one failed healthcheck while every deploy succeeds (ISS-429)
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

  it('writes the target holds even when the dispatch carried no requestId — a run with no holds reads as proven', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ deployment_uuid: 'dep-x' }), { status: 200 }),
    ) as unknown as typeof fetch;

    await coolifyAdapter.dispatchOutbound(twoTargetCtx(), {
      eventName: 'release.requested',
      payload: { runId: RUN_ID },
    });

    expect(replaceHoldsMock).toHaveBeenCalledTimes(1);
    const args = replaceHoldsMock.mock.calls[0]?.[0] as { requestId?: string; targets: unknown[] };
    expect(args.requestId).toBeUndefined();
    expect(args.targets).toHaveLength(2);
  });

  it('reports at ERROR level when the run went terminal mid-dispatch and refused the holds', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ deployment_uuid: 'dep-y' }), { status: 200 }),
    ) as unknown as typeof fetch;
    replaceHoldsMock.mockResolvedValueOnce(false);
    const errorSpy = vi.spyOn(logger, 'error').mockReturnValue(undefined as never);

    await coolifyAdapter.dispatchOutbound(twoTargetCtx(), {
      eventName: 'release.requested',
      payload: { runId: RUN_ID },
      requestId: 'req-3',
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID }),
      expect.stringContaining('no run can witness its outcome'),
    );
    errorSpy.mockRestore();
  });

  it('handleInbound REFUSES by name rather than accepting a body it cannot have verified', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: refusal takes no meaningful args
      (coolifyAdapter as any).handleInbound(),
    ).rejects.toThrow(/inbound webhooks are not supported/);
  });
});

describe('coolifyAdapter.dispatchOutbound — a refused deploy is not a rejected credential (ISS-924)', () => {
  beforeEach(() => {
    findConnectionByIdMock.mockResolvedValue({ id: CONN_ID, active: true });
    recordDeliveryMock.mockResolvedValue('del-1');
  });

  async function deployWith(status: number): Promise<void> {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status }),
    ) as unknown as typeof fetch;
    await expect(
      coolifyAdapter.dispatchOutbound(buildCtx({ apiToken: 'cf-current' }), {
        eventName: 'deploy',
        payload: { runId: null, issueId: null },
      }),
    ).rejects.toThrow(/coolify deploy failed/);
  }

  it('writes needs_scope when the deploy route answers 403', async () => {
    await deployWith(403);

    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_scope' }),
    );
    expect(updateConnectionMock).not.toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('names the deploy ability, which the read-only healthcheck never exercises', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(
      coolifyAdapter.dispatchOutbound(buildCtx({ apiToken: 'cf-current' }), {
        eventName: 'deploy',
        payload: { runId: null, issueId: null },
      }),
    ).rejects.toThrow(/api\.ability:deploy/);
  });

  it('still writes needs_reauth when the deploy route answers 401', async () => {
    await deployWith(401);

    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('writes no credential verdict at all for a 500', async () => {
    await deployWith(500);

    const written = updateConnectionMock.mock.calls.map(
      (c) => (c[1] as { lastHealthStatus?: string }).lastHealthStatus,
    );
    expect(written).not.toContain('needs_scope');
    expect(written).not.toContain('needs_reauth');
  });
});
