import { afterEach, describe, expect, it, vi } from 'vitest';

const buildContextFromBindingMock = vi.fn();
vi.mock('../store.js', () => ({
  buildContextFromBinding: (...a: unknown[]) => buildContextFromBindingMock(...(a as [])),
  updateConnection: vi.fn(),
  findConnectionById: vi.fn(),
}));
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../pipeline/runs.js', () => ({ closeRun: vi.fn(), setCurrentStep: vi.fn() }));
vi.mock('../deliveries.js', () => ({
  recordDelivery: vi.fn(),
  updateDelivery: vi.fn(),
}));
vi.mock('../../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn(), captureMessage: vi.fn() },
}));

const { fetchCoolifyDeploymentLogs } = await import('./log-fetch.js');

const PAIR = {} as Parameters<typeof fetchCoolifyDeploymentLogs>[0];

function logLines(count: number) {
  return Array.from({ length: count }, (_, i) => `step ${i}`).join('\n');
}

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

describe('fetchCoolifyDeploymentLogs — a snapshot that cannot be mistaken for live', () => {
  it('honours `lines`, which the tool advertised and silently ignored (ISS-787)', async () => {
    respondWith({ status: 'in_progress', logs: logLines(50) });

    const res = await fetchCoolifyDeploymentLogs(PAIR, 'dep-1', 3);

    expect(res.logs.split('\n')).toEqual(['step 47', 'step 48', 'step 49']);
    expect(res.truncated).toBe(true);
  });

  it('falls back to the 100-line tail when `lines` is omitted', async () => {
    respondWith({ status: 'in_progress', logs: logLines(50) });

    const res = await fetchCoolifyDeploymentLogs(PAIR, 'dep-1');

    expect(res.logs.split('\n')).toHaveLength(50);
    expect(res.truncated).toBe(false);
  });

  it('stamps fetchedAt and a digest of the returned text, so two reads are comparable', async () => {
    respondWith({ status: 'in_progress', logs: logLines(5) });
    const first = await fetchCoolifyDeploymentLogs(PAIR, 'dep-1');

    respondWith({ status: 'in_progress', logs: logLines(5) });
    const second = await fetchCoolifyDeploymentLogs(PAIR, 'dep-1');

    expect(first.logsDigest).toBe(second.logsDigest);
    expect(Date.parse(first.fetchedAt)).not.toBeNaN();
    expect(Date.parse(second.fetchedAt)).toBeGreaterThanOrEqual(Date.parse(first.fetchedAt));
  });

  it('moves the digest when one line of the log advances', async () => {
    respondWith({ status: 'in_progress', logs: logLines(5) });
    const before = await fetchCoolifyDeploymentLogs(PAIR, 'dep-1');

    respondWith({ status: 'in_progress', logs: logLines(6) });
    const after = await fetchCoolifyDeploymentLogs(PAIR, 'dep-1');

    expect(after.logsDigest).not.toBe(before.logsDigest);
  });
});
