import { beforeEach, describe, expect, it, vi } from 'vitest';

const recentOutboundDeliveriesMock = vi.fn();
vi.mock('../deliveries.js', () => ({
  recentOutboundDeliveries: (...a: unknown[]) => recentOutboundDeliveriesMock(...(a as [])),
}));

const findConnectionByIdMock = vi.fn();
const findBindingByIdMock = vi.fn();
const updateConnectionMock = vi.fn();
vi.mock('../store.js', () => ({
  findConnectionById: (...a: unknown[]) => findConnectionByIdMock(...(a as [])),
  findBindingById: (...a: unknown[]) => findBindingByIdMock(...(a as [])),
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
}));

vi.mock('../../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { captureMessage: vi.fn() },
}));

const {
  evaluateBreaker,
  maybeTripBreaker,
  maybeResetBreaker,
  breakerAllowsDispatch,
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_COOLDOWN_MS,
} = await import('./circuit-breaker.js');

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

  it('maybeTripBreaker flips connection active=false + stamps breakerOpenedAt', async () => {
    recentOutboundDeliveriesMock.mockResolvedValueOnce(failed(BREAKER_FAILURE_THRESHOLD));
    findConnectionByIdMock.mockResolvedValueOnce({
      id: 'conn-1',
      provider: 'coolify',
      active: true,
    });
    findBindingByIdMock.mockResolvedValueOnce({
      id: 'bind-1',
      projectId: 'p-1',
      environment: 'staging',
    });

    const tripped = await maybeTripBreaker({ bindingId: 'bind-1', connectionId: 'conn-1' });
    expect(tripped).toBe(true);
    expect(updateConnectionMock).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ active: false, breakerOpenedAt: expect.any(Date) }),
    );
  });

  it('maybeTripBreaker is a no-op when breaker already open', async () => {
    recentOutboundDeliveriesMock.mockResolvedValueOnce(failed(BREAKER_FAILURE_THRESHOLD));
    findConnectionByIdMock.mockResolvedValueOnce({
      id: 'conn-1',
      provider: 'coolify',
      active: false,
    });

    const tripped = await maybeTripBreaker({ bindingId: 'bind-1', connectionId: 'conn-1' });
    expect(tripped).toBe(false);
    expect(updateConnectionMock).not.toHaveBeenCalled();
  });

  it('maybeResetBreaker re-opens an inactive connection after a success', async () => {
    findConnectionByIdMock.mockResolvedValueOnce({ id: 'conn-1', active: false });
    await maybeResetBreaker('conn-1');
    expect(updateConnectionMock).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ active: true, breakerOpenedAt: null }),
    );
  });

  it('maybeResetBreaker is a no-op when connection is already active', async () => {
    findConnectionByIdMock.mockResolvedValueOnce({ id: 'conn-1', active: true });
    await maybeResetBreaker('conn-1');
    expect(updateConnectionMock).not.toHaveBeenCalled();
  });
});

describe('breakerAllowsDispatch — half-open recovery (no-deadlock)', () => {
  it('allows dispatch when the breaker is closed (active)', async () => {
    const r = await breakerAllowsDispatch({ id: 'conn-1', active: true, breakerOpenedAt: null });
    expect(r).toEqual({ allow: true, halfOpen: false });
    expect(updateConnectionMock).not.toHaveBeenCalled();
  });

  it('denies dispatch while open and still within cooldown', async () => {
    const r = await breakerAllowsDispatch({
      id: 'conn-1',
      active: false,
      breakerOpenedAt: new Date(Date.now() - 60_000), // 1 min ago, < cooldown
    });
    expect(r.allow).toBe(false);
    expect(updateConnectionMock).not.toHaveBeenCalled();
  });

  it('half-opens (allows one trial + re-stamps) once cooldown has elapsed', async () => {
    const r = await breakerAllowsDispatch({
      id: 'conn-1',
      active: false,
      breakerOpenedAt: new Date(Date.now() - BREAKER_COOLDOWN_MS - 1_000),
    });
    expect(r).toEqual({ allow: true, halfOpen: true });
    // Re-stamps breakerOpenedAt so a failing trial waits another full cooldown.
    expect(updateConnectionMock).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ breakerOpenedAt: expect.any(Date) }),
    );
  });

  it('denies an open breaker with no timestamp (cannot compute cooldown)', async () => {
    const r = await breakerAllowsDispatch({ id: 'conn-1', active: false, breakerOpenedAt: null });
    expect(r.allow).toBe(false);
  });
});
