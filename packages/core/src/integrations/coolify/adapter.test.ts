import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConnectionMock = vi.fn();
vi.mock('../store.js', () => ({
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
  // healthcheck only touches updateConnection; the rest are unused here.
  findConnectionById: vi.fn(),
  buildContextFromBinding: vi.fn(),
}));

// Stub the modules whose import chains pull in the db client / env (not needed
// for the healthcheck path) so this suite runs without a configured database.
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../deliveries.js', () => ({ recordDelivery: vi.fn(), updateDelivery: vi.fn() }));
vi.mock('../../pipeline/runs.js', () => ({ closeRun: vi.fn(), setCurrentStepForce: vi.fn() }));
vi.mock('./circuit-breaker.js', () => ({ maybeTripBreaker: vi.fn(), maybeResetBreaker: vi.fn() }));
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
    config: { baseUrl: 'https://coolify.example', resourceUuid: 'res-1' },
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
