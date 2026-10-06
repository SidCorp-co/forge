import { beforeEach, describe, expect, it, vi } from 'vitest';

const bossInsert = vi.fn();
vi.mock('../queue/boss.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  boss: { insert: (...args: unknown[]) => bossInsert(...args) },
}));
vi.mock('./worker.js', () => ({ wakeConsumers: vi.fn() }));

const { emitEvent } = await import('./emit.js');

/** An executor whose `transaction` hands its callback `unit`, and whose own writes are refused. */
function pool(unit: unknown) {
  const refuse = () => {
    throw new Error('the event was written on the pool, outside any transaction');
  };
  return {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(unit)),
    insert: refuse,
    execute: refuse,
  };
}

function unitExecutor() {
  const rows = (
    values: { type: string; issueId: string | null; projectId: string | null; payload: unknown }[],
  ) => values.map((v, i) => ({ ...v, id: `event-${i}`, seq: i + 1, createdAt: new Date(0) }));
  return {
    insert: vi.fn(() => ({ values: (v: never[]) => ({ returning: async () => rows(v) }) })),
    execute: vi.fn(),
  };
}

describe('emitEvent writes the event and its deliveries as one unit', () => {
  beforeEach(() => bossInsert.mockReset());

  it('on the pool, the event row and every delivery job are written inside one transaction', async () => {
    const unit = unitExecutor();
    const db = pool(unit);
    await emitEvent(db as never, 'issue.pushed', {
      projectId: 'p',
      event: 'issue.pipelineHealth.changed',
      data: { id: 'i' },
    } as never);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(unit.insert).toHaveBeenCalledTimes(1);
    expect(bossInsert).toHaveBeenCalled();
    for (const [, , options] of bossInsert.mock.calls) expect(options.db).toBeDefined();
  });

  it('a delivery job that cannot be written fails the emit instead of leaving the row behind', async () => {
    bossInsert.mockRejectedValueOnce(new Error('pgboss.job is not there'));
    const db = pool(unitExecutor());
    await expect(
      emitEvent(db as never, 'issue.pushed', {
        projectId: 'p',
        event: 'issue.unblockCascade',
        data: {},
      } as never),
    ).rejects.toThrow('pgboss.job is not there');
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
