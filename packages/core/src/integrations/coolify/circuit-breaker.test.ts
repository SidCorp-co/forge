import { beforeEach, describe, expect, it, vi } from 'vitest';

const recentOutboundDeliveriesMock = vi.fn();
vi.mock('../deliveries.js', () => ({
  recentOutboundDeliveries: (...a: unknown[]) => recentOutboundDeliveriesMock(...(a as [])),
}));

const findByIdMock = vi.fn();
const updateIntegrationMock = vi.fn();
vi.mock('../store.js', () => ({
  findById: (...a: unknown[]) => findByIdMock(...(a as [])),
  updateIntegration: (...a: unknown[]) => updateIntegrationMock(...(a as [])),
}));

vi.mock('../../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { captureMessage: vi.fn() },
}));

const { evaluateBreaker, maybeTripBreaker, maybeResetBreaker, BREAKER_FAILURE_THRESHOLD } =
  await import('./circuit-breaker.js');

const failed = (n: number) =>
  Array.from({ length: n }, () => ({ status: 'failed' as const, createdAt: new Date() }));
const ok = (n: number) =>
  Array.from({ length: n }, () => ({ status: 'ok' as const, createdAt: new Date() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('coolify circuit breaker', () => {
  it('stays closed when fewer than threshold failures', async () => {
    recentOutboundDeliveriesMock.mockResolvedValueOnce(failed(BREAKER_FAILURE_THRESHOLD - 1));
    const ev = await evaluateBreaker('int-1');
    expect(ev.tripped).toBe(false);
  });

  it('stays closed if any of the last N was a success', async () => {
    recentOutboundDeliveriesMock.mockResolvedValueOnce([...failed(2), ...ok(1)]);
    const ev = await evaluateBreaker('int-1');
    expect(ev.tripped).toBe(false);
  });

  it('trips when last N are all failures', async () => {
    recentOutboundDeliveriesMock.mockResolvedValueOnce(failed(BREAKER_FAILURE_THRESHOLD));
    const ev = await evaluateBreaker('int-1');
    expect(ev.tripped).toBe(true);
    expect(ev.consecutiveFailures).toBe(BREAKER_FAILURE_THRESHOLD);
  });

  it('maybeTripBreaker flips active=false + stamps breakerOpenedAt', async () => {
    recentOutboundDeliveriesMock.mockResolvedValueOnce(failed(BREAKER_FAILURE_THRESHOLD));
    findByIdMock.mockResolvedValueOnce({
      id: 'int-1',
      provider: 'coolify',
      environment: 'staging',
      projectId: 'p-1',
      active: true,
    });

    const tripped = await maybeTripBreaker('int-1');
    expect(tripped).toBe(true);
    expect(updateIntegrationMock).toHaveBeenCalledWith(
      'int-1',
      expect.objectContaining({ active: false, breakerOpenedAt: expect.any(Date) }),
    );
  });

  it('maybeTripBreaker is a no-op when breaker already open', async () => {
    recentOutboundDeliveriesMock.mockResolvedValueOnce(failed(BREAKER_FAILURE_THRESHOLD));
    findByIdMock.mockResolvedValueOnce({
      id: 'int-1',
      provider: 'coolify',
      environment: 'staging',
      projectId: 'p-1',
      active: false,
    });

    const tripped = await maybeTripBreaker('int-1');
    expect(tripped).toBe(false);
    expect(updateIntegrationMock).not.toHaveBeenCalled();
  });

  it('maybeResetBreaker re-opens an inactive integration after a success', async () => {
    findByIdMock.mockResolvedValueOnce({ id: 'int-1', active: false });
    await maybeResetBreaker('int-1');
    expect(updateIntegrationMock).toHaveBeenCalledWith(
      'int-1',
      expect.objectContaining({ active: true, breakerOpenedAt: null }),
    );
  });

  it('maybeResetBreaker is a no-op when integration is already active', async () => {
    findByIdMock.mockResolvedValueOnce({ id: 'int-1', active: true });
    await maybeResetBreaker('int-1');
    expect(updateIntegrationMock).not.toHaveBeenCalled();
  });
});
