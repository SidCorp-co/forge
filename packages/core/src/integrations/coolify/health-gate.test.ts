/**
 * ISS-971 — the gate that reads the deployed application.
 *
 * The axis that matters most is the one the pg-boss incident had: no HTTP
 * response at all. A probe that cannot connect must count against the window
 * exactly as a 503 does, and the deadline must end in a rollback rather than in
 * another poll.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    DEVICE_TOKEN_PEPPER: 'test-pepper',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../queue/boss.js', () => ({ boss: { send: vi.fn() } }));

const recordDeliveryMock = vi.fn(async (_input: unknown) => 'inb-1');
const updateDeliveryMock = vi.fn(async (_id: string, _patch: unknown) => {});
vi.mock('../deliveries.js', () => ({
  recordDelivery: (input: unknown) => recordDeliveryMock(input),
  updateDelivery: (id: string, patch: unknown) => updateDeliveryMock(id, patch),
}));

let bindingConfig: Record<string, unknown> = {
  targets: [{ id: 't1', label: 'Backend', resourceUuid: 'res-1', healthUrl: 'https://api/health' }],
};
const findBindingMock = vi.fn(async () => ({
  id: 'bind-1',
  connectionId: 'conn-1',
  projectId: 'proj-1',
}));
let connectionActive = true;
vi.mock('../store.js', () => ({
  findBindingById: (...a: unknown[]) => findBindingMock(...(a as [])),
  findConnectionById: async () => ({ id: 'conn-1', active: connectionActive }),
  effectiveConfig: () => bindingConfig,
}));

const errorLog = vi.fn();
vi.mock('../../logger.js', () => ({
  logger: {
    error: (...a: unknown[]) => errorLog(...a),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  HEALTH_GRACE_MS,
  HEALTH_MIN_WINDOW_MS,
  HEALTH_WINDOW_MS,
  healthGateFor,
  pickRollbackImage,
  probeHealth,
} = await import('./health-gate.js');
const NOW = 1_800_000_000_000;

const IMAGES = [
  { tag: 'sha-new', createdAt: '2026-09-07T10:00:00Z', isCurrent: true },
  { tag: 'sha-good', createdAt: '2026-09-06T10:00:00Z', isCurrent: false },
  { tag: 'sha-older', createdAt: '2026-09-01T10:00:00Z', isCurrent: false },
];

beforeEach(() => {
  recordDeliveryMock.mockResolvedValue('inb-1');
  connectionActive = true;
  bindingConfig = {
    targets: [
      { id: 't1', label: 'Backend', resourceUuid: 'res-1', healthUrl: 'https://api/health' },
    ],
  };
});
afterEach(() => vi.clearAllMocks());

describe('probeHealth', () => {
  it('a connection that is refused is an unhealthy READING, not a missing one', async () => {
    const reading = await probeHealth('https://api/health', async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    });
    expect(reading).toEqual({ healthy: false, reason: 'unreachable (fetch failed: ECONNREFUSED)' });
  });

  it('200 with ok:true is healthy', async () => {
    const reading = await probeHealth(
      'https://api/health',
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    expect(reading).toEqual({ healthy: true });
  });

  it('200 with ok:false names the leg that is down', async () => {
    const reading = await probeHealth(
      'https://api/health',
      async () =>
        new Response(JSON.stringify({ ok: false, db: { ok: false }, queue: { ok: true } }), {
          status: 200,
        }),
    );
    expect(reading).toEqual({ healthy: false, reason: 'ok:false (db down)' });
  });

  it('a 503 is unhealthy even though the process answered', async () => {
    const reading = await probeHealth(
      'https://api/health',
      async () => new Response(JSON.stringify({ ok: false }), { status: 503 }),
    );
    expect(reading).toEqual({ healthy: false, reason: 'http 503' });
  });

  it('a 200 that is not JSON is unhealthy — a proxy error page is not a health reading', async () => {
    const reading = await probeHealth(
      'https://api/health',
      async () => new Response('<html>no available server</html>', { status: 200 }),
    );
    expect(reading).toEqual({ healthy: false, reason: 'http 200 with an unparseable body' });
  });

  it('sends a cache-buster so a cached 200 from the previous build cannot clear a dead deploy', async () => {
    const seen: string[] = [];
    await probeHealth('https://api/health', async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    expect(seen[0]).toContain('_forge_cb=');
  });
});

type Img = { tag: string; createdAt: string | null; isCurrent: boolean };

describe('pickRollbackImage', () => {
  it('takes the newest image that is not the one running now', () => {
    expect(pickRollbackImage(IMAGES, 'sha-new')).toBe('sha-good');
  });

  it('refuses when the only image listed is the current one', () => {
    expect(pickRollbackImage([IMAGES[0] as Img], 'sha-new')).toBeNull();
  });

  it('refuses an empty list — Coolify answers 200 with no images when the server is unreachable', () => {
    expect(pickRollbackImage([], null)).toBeNull();
  });

  it('does not trust a `current` tag that names no listed image', () => {
    const unmarked = IMAGES.map((i) => ({ ...i, isCurrent: false }));
    expect(pickRollbackImage(unmarked, 'sha-that-coolify-does-not-list')).toBeNull();
  });

  it('refuses a list where NOTHING says which image is running — the failed build is the newest in it', () => {
    const unmarked = IMAGES.map((i) => ({ ...i, isCurrent: false }));
    expect(pickRollbackImage(unmarked, null)).toBeNull();
  });

  it('excludes the running build by `current` when no row carries is_current', () => {
    const unmarked = IMAGES.map((i) => ({ ...i, isCurrent: false }));
    expect(pickRollbackImage(unmarked, 'sha-new')).toBe('sha-good');
  });

  it('sorts an unparseable createdAt LAST, whichever order Coolify listed it in', () => {
    const live: Img = { tag: 'sha-new', createdAt: '2026-09-07T10:00:00Z', isCurrent: true };
    const undated: Img = { tag: 'sha-undated', createdAt: null, isCurrent: false };
    const dated: Img = { tag: 'sha-good', createdAt: '2026-09-06T10:00:00Z', isCurrent: false };
    expect(pickRollbackImage([live, undated, dated], 'sha-new')).toBe('sha-good');
    expect(pickRollbackImage([live, dated, undated], 'sha-new')).toBe('sha-good');
  });
});

const gateArgs = {
  config: null as never,
  bindingId: 'bind-1',
  runId: null as string | null,
  deliveryId: null,
  deploymentUuid: 'dep-1',
  targetLabel: 'Backend',
  forRollback: false,
};

describe('healthGateFor', () => {
  it('declines a target that declares no health URL', () => {
    expect(
      healthGateFor({
        ...gateArgs,
        config: {
          baseUrl: 'x',
          environment: 'staging',
          targets: [{ id: 't1', label: 'Backend', resourceUuid: 'r' }],
        } as never,
      }),
    ).toEqual({ kind: 'not-declared' });
  });

  it('never outlives the confirmation hold it defers — a slow build shortens the window', () => {
    const decision = healthGateFor({
      ...gateArgs,
      config: bindingConfig as never,
      notAfter: new Date(NOW + HEALTH_MIN_WINDOW_MS + 5_000).toISOString(),
      now: NOW,
    });
    expect(decision.kind).toBe('gate');
    const job = (decision as { job: { deadlineAt: string; graceUntil: string } }).job;
    expect(Date.parse(job.deadlineAt)).toBe(NOW + HEALTH_MIN_WINDOW_MS + 5_000);
    expect(Date.parse(job.graceUntil)).toBe(NOW + HEALTH_GRACE_MS);
  });

  it('refuses an unparseable confirmation deadline instead of throwing out of toISOString', () => {
    const decision = healthGateFor({
      ...gateArgs,
      config: bindingConfig as never,
      notAfter: 'not a date',
      now: NOW,
    });
    expect(decision.kind).toBe('window-too-short');
  });

  it('REFUSES to gate a window too short to give the container its grace period', () => {
    const decision = healthGateFor({
      ...gateArgs,
      config: bindingConfig as never,
      notAfter: new Date(NOW + 20_000).toISOString(),
      now: NOW,
    });
    expect(decision).toEqual({ kind: 'window-too-short', remainingMs: 20_000 });
  });

  it('refuses a confirmation deadline already past, rather than probing once beyond it', () => {
    const decision = healthGateFor({
      ...gateArgs,
      config: bindingConfig as never,
      notAfter: new Date(NOW - 1_000).toISOString(),
      now: NOW,
    });
    expect(decision.kind).toBe('window-too-short');
  });

  it('opens the window AFTER the grace period, never at the deploy', () => {
    const decision = healthGateFor({ ...gateArgs, config: bindingConfig as never, now: NOW });
    const job = (decision as { job: { deadlineAt: string; graceUntil: string } }).job;
    expect(Date.parse(job.graceUntil)).toBe(NOW + HEALTH_GRACE_MS);
    expect(Date.parse(job.deadlineAt)).toBe(NOW + HEALTH_GRACE_MS + HEALTH_WINDOW_MS);
  });
});
