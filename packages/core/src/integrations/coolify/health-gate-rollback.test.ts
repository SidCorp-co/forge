/**
 * ISS-971 — what one poll of the gate does, and what a failed window does to
 * the application.
 *
 * The decision functions are next door in `health-gate.test.ts`; this file
 * drives the job itself, so every case here needs the binding, the delivery log
 * and the queue.
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

const { runCoolifyHealthGate } = await import('./health-gate.js');
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
  recordDeliveryMock.mockResolvedValue('inb-1');
  connectionActive = true;
  bindingConfig = {
    targets: [
      { id: 't1', label: 'Backend', resourceUuid: 'res-1', healthUrl: 'https://api/health' },
    ],
  };
});
afterEach(() => vi.clearAllMocks());

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
});

describe('the rollback is dispatched at most once, and never left unwatched', () => {
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

  it('pages and settles rather than throwing when the rollback marker cannot be written', async () => {
    recordDeliveryMock.mockImplementation(async (input: unknown) => {
      if ((input as { eventName: string }).eventName === 'deploy.rollback.auto') {
        throw new Error('duplicate key value violates unique constraint');
      }
      return 'inb-1';
    });
    const d = deps();

    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );

    expect(d.rollback).not.toHaveBeenCalled();
    expect(out.rolledBackTo).toBeUndefined();
    expect(d.settle).toHaveBeenCalled();
    expect(errorLog.mock.calls.map((c) => String(c[1])).join(' ')).toContain(
      'could not be recorded',
    );
  });

  it('a queue failure AFTER the rollback still settles the hold and reports the rollback', async () => {
    (boss.send as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('boss is down'),
    );
    const d = deps();

    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );

    expect(out.rolledBackTo).toBe('sha-good');
    expect(d.settle).toHaveBeenCalled();
    const paged = errorLog.mock.calls.map((c) => String(c[1])).join(' ');
    expect(paged).toContain('the restored image is unwatched');
    expect(paged).not.toContain('nothing was rolled back');
  });

  it('says so when the restored image ends up with no health check watching it', async () => {
    bindingConfig = {
      targets: [{ id: 't1', label: 'Backend', resourceUuid: 'res-1' }],
    };
    const d = deps();

    await runCoolifyHealthGate(gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }), d);

    expect(errorLog.mock.calls.map((c) => String(c[1])).join(' ')).toContain(
      'is NOT being health-checked',
    );
  });

  it('closes the rollback marker instead of leaving an outbound delivery in flight forever', async () => {
    await runCoolifyHealthGate(gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }), deps());
    expect(updateDeliveryMock).toHaveBeenCalledWith(
      'inb-1',
      expect.objectContaining({ status: 'ok' }),
    );
  });

  it('closes the marker failed when the rollback was refused', async () => {
    const d = deps({
      rollback: vi.fn(async () => {
        throw new Error('rollback image is not listed by Coolify');
      }),
    });
    await runCoolifyHealthGate(gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }), d);
    expect(updateDeliveryMock).toHaveBeenCalledWith(
      'inb-1',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('a re-run whose unhealthy row already exists still reaches the marker, and rolls back nothing twice', async () => {
    // cm:why this is the shape of a pg-boss retry after a transient failure downstream — the deterministic `health:<uuid>` row collides on the unique index and the marker for the rollback that already went out is present, which is the only way to reach the marker check at all
    recordDeliveryMock.mockImplementation(async (input: unknown) => {
      if ((input as { eventName: string }).eventName === 'deploy.unhealthy') {
        throw new Error('duplicate key value violates unique constraint');
      }
      return 'inb-1';
    });
    const d = deps({ findRollbackMarker: vi.fn(async () => true) });

    const out = await runCoolifyHealthGate(
      gateJob({ deadlineAt: new Date(NOW - 1).toISOString() }),
      d,
    );

    expect(d.rollback).not.toHaveBeenCalled();
    expect(out.verdict).toBe('unhealthy');
    expect(d.settle).toHaveBeenCalledWith(
      'failed',
      expect.stringContaining('never became healthy'),
    );
    const paged = errorLog.mock.calls.map((c) => String(c[1])).join(' ');
    expect(paged).toContain('could not write the unhealthy-deploy row');
    expect(paged).toContain('already dispatched');
  });
});
