import { beforeEach, describe, expect, it, vi } from 'vitest';

const addBreadcrumbMock = vi.fn();
const isSentryEnabledMock = vi.fn(() => true);

vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: (...args: unknown[]) => addBreadcrumbMock(...args) },
  isSentryEnabled: () => isSentryEnabledMock(),
}));

const wsPublishMock = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => wsPublishMock(...args) },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  checkBackstop,
  recordPipelineSweeperTick,
  resetPgBossHealthProbeForTest,
} = await import('./pgboss-health.js');

beforeEach(() => {
  vi.clearAllMocks();
  isSentryEnabledMock.mockReturnValue(true);
  resetPgBossHealthProbeForTest();
});

describe('pgboss-health', () => {
  it('boot grace: no alert if lastTickAt is null and uptime < 90s', () => {
    const fired = checkBackstop({ now: 1_000_000, uptimeMs: 30_000 });
    expect(fired).toBe(false);
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
    expect(wsPublishMock).not.toHaveBeenCalled();
  });

  it('fires once if lastTickAt is null and uptime exceeds boot grace', () => {
    const fired = checkBackstop({ now: 1_000_000, uptimeMs: 120_000 });
    expect(fired).toBe(true);
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    const breadcrumb = addBreadcrumbMock.mock.calls[0]?.[0];
    expect(breadcrumb.category).toBe('dispatcher.tick_missing');
    expect(breadcrumb.level).toBe('warning');
    expect(breadcrumb.data.lastTickAt).toBeNull();
    expect(wsPublishMock).toHaveBeenCalledTimes(1);
    const [room, envelope] = wsPublishMock.mock.calls[0] as [
      string,
      { event: string; data: { lastTickAt: string | null; gapSeconds: number } },
    ];
    expect(room).toBe('global');
    expect(envelope.event).toBe('dispatcher.tick_missing');
  });

  it('healthy: tick recorded 10s ago → no alert', () => {
    const t = 2_000_000;
    recordPipelineSweeperTick(t - 10_000);
    const fired = checkBackstop({ now: t, uptimeMs: 600_000 });
    expect(fired).toBe(false);
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
    expect(wsPublishMock).not.toHaveBeenCalled();
  });

  it('missed: tick recorded 100s ago → fires Sentry breadcrumb + WS publish', () => {
    const t = 3_000_000;
    recordPipelineSweeperTick(t - 100_000);
    const fired = checkBackstop({ now: t, uptimeMs: 600_000 });
    expect(fired).toBe(true);
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    const breadcrumb = addBreadcrumbMock.mock.calls[0]?.[0];
    expect(breadcrumb.data.lastTickAt).toBe(new Date(t - 100_000).toISOString());
    expect(breadcrumb.data.gapSeconds).toBe(100);
    expect(wsPublishMock).toHaveBeenCalledTimes(1);
    const envelope = wsPublishMock.mock.calls[0]?.[1] as {
      event: string;
      data: { gapSeconds: number };
    };
    expect(envelope.event).toBe('dispatcher.tick_missing');
    expect(envelope.data.gapSeconds).toBe(100);
  });

  it('coalesces alerts within the 5-minute cooldown window', () => {
    const base = 4_000_000;
    recordPipelineSweeperTick(base - 100_000);
    expect(checkBackstop({ now: base, uptimeMs: 600_000 })).toBe(true);
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    // Same outage, 60s later — still inside the cooldown, no fresh alert.
    expect(checkBackstop({ now: base + 60000, uptimeMs: 660000 })).toBe(false);
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(wsPublishMock).toHaveBeenCalledTimes(1);
  });

  it('a fresh tick clears the cooldown so the next miss alerts again', () => {
    const base = 5_000_000;
    recordPipelineSweeperTick(base - 100_000);
    expect(checkBackstop({ now: base, uptimeMs: 600_000 })).toBe(true);
    // Recovery: a fresh tick lands.
    recordPipelineSweeperTick(base + 10_000);
    expect(checkBackstop({ now: base + 20_000, uptimeMs: 620_000 })).toBe(false);
    // New outage starts.
    expect(checkBackstop({ now: base + 200_000, uptimeMs: 800_000 })).toBe(true);
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(2);
    expect(wsPublishMock).toHaveBeenCalledTimes(2);
  });

  it('skips the Sentry breadcrumb when Sentry is disabled but still emits WS event', () => {
    isSentryEnabledMock.mockReturnValue(false);
    const t = 6_000_000;
    recordPipelineSweeperTick(t - 100_000);
    const fired = checkBackstop({ now: t, uptimeMs: 600_000 });
    expect(fired).toBe(true);
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
    expect(wsPublishMock).toHaveBeenCalledTimes(1);
  });
});
