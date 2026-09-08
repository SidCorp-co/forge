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
vi.mock('../deliveries.js', () => ({
  recordDelivery: (input: unknown) => recordDeliveryMock(input),
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
  runCoolifyHealthGate,
} = await import('./health-gate.js');
const { boss } = await import('../../queue/boss.js');

const sendCalls = () => (boss.send as unknown as { mock: { calls: unknown[][] } }).mock.calls;
const queuedGates = () =>
  sendCalls().filter((c) => (c[1] as { jobKind?: string })?.jobKind === 'coolify.health-gate');

const NOW = 1_800_000_000_000;

function gateJob(over: Record<string, unknown> = {}) {
  return {
    jobKind: 'coolify.health-gate' as const,
    bindingId: 'bind-1',
    runId: 'run-1' as string | null,
    deliveryId: 'del-1' as string | null,
    deploymentUuid: 'dep-1',
    targetId: 't1',
    targetLabel: 'Backend',
    healthUrl: 'https://api/health',
    graceUntil: new Date(NOW - 1).toISOString(),
    deadlineAt: new Date(NOW + 60_000).toISOString(),
    forRollback: false,
    ...over,
  };
}

const IMAGES = [
  { tag: 'sha-new', createdAt: '2026-09-07T10:00:00Z', isCurrent: true },
  { tag: 'sha-good', createdAt: '2026-09-06T10:00:00Z', isCurrent: false },
  { tag: 'sha-older', createdAt: '2026-09-01T10:00:00Z', isCurrent: false },
];

function deps(over: Record<string, unknown> = {}) {
  return {
    probe: vi.fn(async () => ({ healthy: false, reason: 'unreachable (ECONNREFUSED)' })),
    settle: vi.fn(async () => {}),
    rollback: vi.fn(async () => ({ performed: true, deploymentUuid: 'dep-rb' })),
    listImages: vi.fn(async () => ({ current: 'sha-new', images: IMAGES })),
    findRollbackMarker: vi.fn(async () => false),
    now: () => NOW,
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: the test builds a partial deps bag on purpose
  } as any;
}

beforeEach(() => {
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

  it('refuses a list where NOTHING says which image is running — the failed build is the newest in it', () => {
    const unmarked = IMAGES.map((i) => ({ ...i, isCurrent: false }));
    expect(pickRollbackImage(unmarked, null)).toBeNull();
  });

  it('excludes the running build by `current` when no row carries is_current', () => {
    const unmarked = IMAGES.map((i) => ({ ...i, isCurrent: false }));
    expect(pickRollbackImage(unmarked, 'sha-new')).toBe('sha-good');
  });

  it('sorts an unparseable createdAt LAST, whichever order Coolify listed it in', () => {
    const undated: Img = { tag: 'sha-undated', createdAt: null, isCurrent: false };
    const dated: Img = { tag: 'sha-good', createdAt: '2026-09-06T10:00:00Z', isCurrent: false };
    expect(pickRollbackImage([undated, dated], 'sha-new')).toBe('sha-good');
    expect(pickRollbackImage([dated, undated], 'sha-new')).toBe('sha-good');
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

describe('runCoolifyHealthGate', () => {
  it('takes no reading before the grace period elapses', async () => {
    const d = deps();
    const out = await runCoolifyHealthGate(
      gateJob({ graceUntil: new Date(NOW + 30_000).toISOString() }),
      d,
    );
    expect(out).toEqual({ verdict: null });
    expect(d.probe).not.toHaveBeenCalled();
    expect(queuedGates()).toHaveLength(1);
  });

  it('the first healthy reading settles the hold succeeded', async () => {
    const d = deps({ probe: vi.fn(async () => ({ healthy: true })) });
    expect(await runCoolifyHealthGate(gateJob(), d)).toEqual({ verdict: 'healthy' });
    expect(d.settle).toHaveBeenCalledWith('succeeded');
    expect(d.rollback).not.toHaveBeenCalled();
  });

  it('an unhealthy reading inside the window queues another poll and settles nothing', async () => {
    const d = deps();
    const out = await runCoolifyHealthGate(gateJob(), d);
    expect(out.verdict).toBeNull();
    expect(d.settle).not.toHaveBeenCalled();
    expect(queuedGates()).toHaveLength(1);
  });

  it('the deadline with no healthy reading fails the hold and names the last reading', async () => {
    const d = deps();
    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );
    expect(out.verdict).toBe('unhealthy');
    expect(d.settle.mock.calls[0]?.[0]).toBe('failed');
    expect(String(d.settle.mock.calls[0]?.[1])).toContain('unreachable (ECONNREFUSED)');
  });

  it('records which deploy failed, as an inbound delivery naming its deployment uuid', async () => {
    await runCoolifyHealthGate(gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }), deps());
    expect(recordDeliveryMock.mock.calls[0]?.[0]).toMatchObject({
      direction: 'inbound',
      eventName: 'deploy.unhealthy',
      payload: { deployment_uuid: 'dep-1', targetLabel: 'Backend' },
    });
  });
});

describe('the rollback a failed gate dispatches', () => {
  it('rolls back to the previous image and health-gates the rollback', async () => {
    const d = deps();
    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );
    expect(d.rollback).toHaveBeenCalledWith({
      projectId: 'proj-1',
      integrationId: 'bind-1',
      resourceUuid: 'res-1',
      commit: 'sha-good',
    });
    expect(out.rolledBackTo).toBe('sha-good');
    expect(queuedGates().at(-1)?.[1]).toMatchObject({
      deploymentUuid: 'dep-rb',
      forRollback: true,
      deliveryId: null,
    });
  });

  it('dispatches nothing when Coolify lists no image other than the current one', async () => {
    const d = deps({
      listImages: vi.fn(async () => ({ current: 'sha-new', images: [IMAGES[0]] })),
    });
    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );
    expect(d.rollback).not.toHaveBeenCalled();
    expect(out.rolledBackTo).toBeUndefined();
    expect(errorLog.mock.calls.map((c) => String(c[1])).join(' ')).toContain(
      'named no earlier image it could be restored to',
    );
  });

  it('pages when the rollback was accepted but not performed — the human-confirm gate said no', async () => {
    const d = deps({
      rollback: vi.fn(async () => ({
        performed: false,
        deploymentUuid: null,
        detail: 'rollback against a production binding is not dispatched without a human',
      })),
    });
    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );
    expect(out.rolledBackTo).toBeUndefined();
    expect(errorLog.mock.calls.map((c) => String(c[1])).join(' ')).toContain(
      'the rollback was not dispatched',
    );
    expect(d.settle.mock.calls[0]?.[0]).toBe('failed');
  });

  it('pages when the rollback itself is refused, and still fails the hold', async () => {
    const d = deps({
      rollback: vi.fn(async () => {
        throw new Error('rollback image "sha-good" is not listed by Coolify');
      }),
    });
    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );
    expect(out.verdict).toBe('unhealthy');
    expect(errorLog.mock.calls.map((c) => String(c[1])).join(' ')).toContain(
      'rollback was REFUSED',
    );
    expect(d.settle).toHaveBeenCalled();
  });

  it('a rollback that never serves pages and dispatches no second rollback', async () => {
    const d = deps();
    const out = await runCoolifyHealthGate(
      gateJob({
        forRollback: true,
        deliveryId: null,
        runId: null,
        deadlineAt: new Date(NOW - 1).toISOString(),
      }),
      d,
    );
    expect(out.verdict).toBe('unhealthy');
    expect(d.rollback).not.toHaveBeenCalled();
    expect(d.settle).not.toHaveBeenCalled();
    expect(recordDeliveryMock.mock.calls[0]?.[0]).toMatchObject({
      eventName: 'deploy.rollback.unhealthy',
    });
    expect(errorLog.mock.calls.map((c) => String(c[1])).join(' ')).toContain(
      'the ROLLBACK is not serving either',
    );
  });

  it('a healthy rollback settles nothing — the failed deploy already owns the hold', async () => {
    const d = deps({ probe: vi.fn(async () => ({ healthy: true })) });
    expect(await runCoolifyHealthGate(gateJob({ forRollback: true, deliveryId: null }), d)).toEqual(
      { verdict: 'healthy' },
    );
    expect(d.settle).not.toHaveBeenCalled();
  });

  it('cannot roll back a target the config no longer holds, and says so', async () => {
    bindingConfig = { targets: [] };
    const d = deps();
    await runCoolifyHealthGate(gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }), d);
    expect(d.listImages).not.toHaveBeenCalled();
    expect(errorLog.mock.calls.map((c) => String(c[1])).join(' ')).toContain(
      'no longer configured',
    );
  });

  it('does not roll back a second time when a marker for this deploy already exists', async () => {
    const d = deps({ findRollbackMarker: vi.fn(async () => true) });
    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );
    expect(d.rollback).not.toHaveBeenCalled();
    expect(out.rolledBackTo).toBeUndefined();
    expect(errorLog.mock.calls.map((c) => String(c[1])).join(' ')).toContain('already dispatched');
    expect(d.settle.mock.calls[0]?.[0]).toBe('failed');
  });

  it('writes the rollback marker BEFORE dispatching, so a retry after a throw cannot double it', async () => {
    const d = deps();
    await runCoolifyHealthGate(gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }), d);
    const events = recordDeliveryMock.mock.calls.map(
      (c) => (c[0] as { eventName: string }).eventName,
    );
    expect(events).toEqual(['deploy.unhealthy', 'deploy.rollback.auto']);
    expect(recordDeliveryMock.mock.calls[1]?.[0]).toMatchObject({
      direction: 'outbound',
      requestId: 'health-rollback:dep-1',
    });
  });

  it('names the OPEN circuit breaker rather than reporting a configuration problem', async () => {
    connectionActive = false;
    const d = deps();
    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );
    expect(d.listImages).not.toHaveBeenCalled();
    expect(d.rollback).not.toHaveBeenCalled();
    expect(out.rolledBackTo).toBeUndefined();
    expect(errorLog.mock.calls.map((c) => String(c[1])).join(' ')).toContain(
      'circuit breaker is OPEN',
    );
  });
});
