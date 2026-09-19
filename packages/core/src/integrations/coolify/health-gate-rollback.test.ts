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
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    probe: vi.fn(async () => ({ healthy: false, reason: 'unreachable (ECONNREFUSED)' })),
    settle: vi.fn(async () => {}),
    now: () => NOW,
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: the test builds a partial deps bag on purpose
  } as any;
}

beforeEach(() => {
  recordDeliveryMock.mockResolvedValue('inb-1');
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

describe('a window that closes unhealthy repairs nothing by itself', () => {
  const closed = () => gateJob({ deadlineAt: new Date(NOW - 1).toISOString() });

  it('queues no further work of any kind', async () => {
    await runCoolifyHealthGate(closed(), deps());

    expect(sendCalls()).toEqual([]);
  });

  it('writes the unhealthy row and no rollback row beside it', async () => {
    await runCoolifyHealthGate(closed(), deps());

    expect(
      recordDeliveryMock.mock.calls.map((c) => (c[0] as { eventName: string }).eventName),
    ).toEqual(['deploy.unhealthy']);
  });

  it('fails the deploy hold, naming the last reading', async () => {
    const d = deps();

    const out = await runCoolifyHealthGate(closed(), d);

    expect(out).toEqual({ verdict: 'unhealthy', reason: expect.any(String) });
    expect(d.settle.mock.calls[0]?.[0]).toBe('failed');
    expect(String(d.settle.mock.calls[0]?.[1])).toContain('unreachable (ECONNREFUSED)');
  });

  it('pages saying the failed build is still serving and nothing was rolled back', async () => {
    await runCoolifyHealthGate(closed(), deps());

    const paged = errorLog.mock.calls.map((c) => String(c[1])).join(' ');
    expect(paged).toContain('NOTHING was rolled back');
    expect(paged).toContain('still serving');
  });

  it('still fails the hold when the unhealthy row cannot be written', async () => {
    recordDeliveryMock.mockRejectedValueOnce(new Error('duplicate key value violates unique'));
    const d = deps();

    const out = await runCoolifyHealthGate(closed(), d);

    expect(out.verdict).toBe('unhealthy');
    expect(d.settle.mock.calls[0]?.[0]).toBe('failed');
  });
});

describe('the operator keeps the rollback this gate gave up', () => {
  it('leaves runCoolifyRollback and listCoolifyRollbackImages reachable from the integration routes', async () => {
    const { readFile } = await import('node:fs/promises');
    const routes = await readFile(new URL('./routes.ts', import.meta.url).pathname, 'utf8');

    expect(routes).toContain('runCoolifyRollback(');
    expect(routes).toContain('listCoolifyRollbackImages(');
  });

  it('leaves no automatic caller of either in the health gate', async () => {
    const { readFile } = await import('node:fs/promises');
    const gate = await readFile(new URL('./health-gate.ts', import.meta.url).pathname, 'utf8');

    expect(gate).not.toContain('deploy.rollback.auto');
    expect(gate).not.toMatch(/deps\.rollback|deps\.listImages/);
  });
});
