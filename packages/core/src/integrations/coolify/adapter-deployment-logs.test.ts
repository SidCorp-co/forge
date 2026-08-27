import { afterEach, describe, expect, it, vi } from 'vitest';

const buildContextFromBindingMock = vi.fn();
vi.mock('../store.js', () => ({
  buildContextFromBinding: (...a: unknown[]) => buildContextFromBindingMock(...(a as [])),
  updateConnection: vi.fn(),
  findConnectionById: vi.fn(),
}));
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../pipeline/runs.js', () => ({ closeRun: vi.fn(), setCurrentStepForce: vi.fn() }));
vi.mock('../deliveries.js', () => ({
  recordDelivery: vi.fn(),
  updateDelivery: vi.fn(),
  findOutboundByDeploymentUuid: vi.fn(),
  listDispatchedOutboundForRun: vi.fn(),
  findInboundByDeploymentUuid: vi.fn(),
}));
vi.mock('../../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn(), captureMessage: vi.fn() },
}));

const { fetchCoolifyDeploymentLogs } = await import('./adapter.js');

const PAIR = {} as Parameters<typeof fetchCoolifyDeploymentLogs>[0];

function respondWith(body: Record<string, unknown>) {
  const impl = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', impl);
  buildContextFromBindingMock.mockReturnValue({
    config: { baseUrl: 'https://coolify.example' },
    secrets: { apiToken: 'tok' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  buildContextFromBindingMock.mockReset();
});

describe('fetchCoolifyDeploymentLogs', () => {
  it('reports the commit Coolify built, which the scrubbed log can never carry', async () => {
    respondWith({
      status: 'finished',
      commit: '2a38b4a83e9e320aca95ec7b14f2526c6c2a0196',
      logs: 'Creating .env file with runtime variables for build phase.\nSOURCE_COMMIT=2a38b4a8\n',
    });
    const res = await fetchCoolifyDeploymentLogs(PAIR, 'dep-1');
    expect(res.commit).toBe('2a38b4a83e9e320aca95ec7b14f2526c6c2a0196');
    expect(res.logs).toContain('SOURCE_COMMIT=[Filtered]');
    expect(res.logs).not.toContain('SOURCE_COMMIT=2a38b4a8');
  });

  it('answers null rather than guessing when Coolify reports no commit', async () => {
    respondWith({ status: 'queued', logs: '' });
    const res = await fetchCoolifyDeploymentLogs(PAIR, 'dep-2');
    expect(res.commit).toBeNull();
    expect(res.status).toBe('queued');
  });
});
