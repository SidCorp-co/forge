import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// db.select chain: select().from().innerJoin().where().orderBy() → Promise<pairs>
const orderBy = vi.fn();
const where = vi.fn(() => ({ orderBy }));
const innerJoin = vi.fn(() => ({ where }));
const from = vi.fn(() => ({ innerJoin }));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from })) },
}));
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../queue/boss.js', () => ({ boss: {} }));

const getAdapter = vi.fn();
vi.mock('./registry.js', () => ({
  getAdapter: (...a: unknown[]) => getAdapter(...(a as [])),
}));

// buildContextFromBinding decrypts secrets — stub it so no vault key is needed.
vi.mock('./store.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildContextFromBinding: vi.fn(() => ({})) };
});

const { runIntegrationsHealthSweep } = await import('./health-sweep.js');

function pair(over: {
  connectionId: string;
  provider?: string;
  lastHealthAt?: Date | null;
}) {
  return {
    binding: {
      id: `bind-${over.connectionId}`,
      connectionId: over.connectionId,
      projectId: 'p-1',
      provider: over.provider ?? 'postman',
      environment: 'prod',
      config: {},
      integrationSecret: null,
      active: true,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    },
    connection: {
      id: over.connectionId,
      provider: over.provider ?? 'postman',
      config: {},
      secretsEnc: 'enc',
      active: true,
      lastHealthStatus: null,
      lastHealthAt: over.lastHealthAt ?? null,
      breakerOpenedAt: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runIntegrationsHealthSweep', () => {
  it('probes one representative pair per connection and skips fresh ones', async () => {
    const stale = pair({ connectionId: 'conn-stale' }); // never checked → probe
    const staleDup = pair({ connectionId: 'conn-stale' }); // same connection → dedup
    const fresh = pair({
      connectionId: 'conn-fresh',
      lastHealthAt: new Date(), // checked just now → skip
    });
    orderBy.mockResolvedValueOnce([stale, staleDup, fresh]);

    const healthcheck = vi.fn(async () => ({ status: 'ok' }));
    getAdapter.mockReturnValue({ healthcheck });

    const result = await runIntegrationsHealthSweep();

    expect(result.probed).toBe(1);
    expect(result.skippedFresh).toBe(1);
    expect(result.failed).toBe(0);
    expect(healthcheck).toHaveBeenCalledTimes(1);
  });

  it('a crashing probe counts as failed and does not stop the sweep', async () => {
    orderBy.mockResolvedValueOnce([
      pair({ connectionId: 'conn-a' }),
      pair({ connectionId: 'conn-b' }),
    ]);
    const healthcheck = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'ok' });
    getAdapter.mockReturnValue({ healthcheck });

    const result = await runIntegrationsHealthSweep();

    expect(result.failed).toBe(1);
    expect(result.probed).toBe(1);
    expect(healthcheck).toHaveBeenCalledTimes(2);
  });

  it('skips providers with no registered adapter', async () => {
    orderBy.mockResolvedValueOnce([pair({ connectionId: 'conn-x' })]);
    getAdapter.mockReturnValue(undefined);

    const result = await runIntegrationsHealthSweep();

    expect(result.probed).toBe(0);
    expect(result.failed).toBe(0);
  });
});
