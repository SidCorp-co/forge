import { beforeEach, describe, expect, it, vi } from 'vitest';

const createQueueMock = vi.fn(async () => undefined);
const workMock = vi.fn(async () => undefined);
const scheduleMock = vi.fn(async () => undefined);

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: createQueueMock,
    work: workMock,
    schedule: scheduleMock,
  },
}));

vi.mock('../db/client.js', () => ({
  db: { execute: vi.fn(async () => ({ count: 0 })) },
}));

const { registerMemoryPruneSweeper, resetMemoryPruneSweeperForTest, MEMORY_PRUNE_QUEUE } =
  await import('./prune-cron.js');

beforeEach(() => {
  resetMemoryPruneSweeperForTest();
  createQueueMock.mockClear();
  workMock.mockClear();
  scheduleMock.mockClear();
});

describe('memory/prune-cron — registerMemoryPruneSweeper', () => {
  it('registers queue, worker, and 04:00 daily schedule once', async () => {
    await registerMemoryPruneSweeper();
    expect(createQueueMock).toHaveBeenCalledTimes(1);
    expect(createQueueMock).toHaveBeenCalledWith(MEMORY_PRUNE_QUEUE);
    expect(workMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledWith(MEMORY_PRUNE_QUEUE, '0 4 * * *');
  });

  it('is idempotent — second call is a no-op', async () => {
    await registerMemoryPruneSweeper();
    await registerMemoryPruneSweeper();
    expect(createQueueMock).toHaveBeenCalledTimes(1);
    expect(workMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });
});
