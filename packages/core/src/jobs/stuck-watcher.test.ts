import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'y'.repeat(32);
vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

vi.mock('../queue/boss.js', () => ({
  boss: {},
}));

const dbExecute = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { execute: dbExecute },
}));

const scheduleRetryMock = vi.fn();
vi.mock('./retry.js', () => ({
  scheduleRetry: (...args: unknown[]) => scheduleRetryMock(...args),
}));

const { runStuckSweep } = await import('./stuck-watcher.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('jobs/stuck-watcher runStuckSweep', () => {
  it('returns zero counts when no rows match', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await runStuckSweep();
    expect(result.markedFailed).toBe(0);
    expect(result.retriesScheduled).toBe(0);
    expect(scheduleRetryMock).not.toHaveBeenCalled();
  });

  it('marks stuck rows failed and counts retries the retry helper schedules', async () => {
    const stuckRows = [
      { id: 'job-1', status: 'failed', attempts: 0, maxAttempts: 3 },
      { id: 'job-2', status: 'failed', attempts: 1, maxAttempts: 3 },
      { id: 'job-3', status: 'failed', attempts: 3, maxAttempts: 3 },
    ];
    dbExecute.mockResolvedValueOnce(stuckRows);
    scheduleRetryMock
      .mockResolvedValueOnce({ scheduled: true, newJobId: 'r1' })
      .mockResolvedValueOnce({ scheduled: true, newJobId: 'r2' })
      .mockResolvedValueOnce({ scheduled: false }); // hit cap

    const result = await runStuckSweep();
    expect(result.markedFailed).toBe(3);
    expect(result.retriesScheduled).toBe(2);
    expect(scheduleRetryMock).toHaveBeenCalledTimes(3);
    expect(scheduleRetryMock).toHaveBeenCalledWith(
      stuckRows[0],
      expect.stringContaining('watchdog'),
    );
  });

  it('survives scheduleRetry throwing — sweep continues for remaining rows', async () => {
    const stuckRows = [
      { id: 'job-1', status: 'failed', attempts: 0, maxAttempts: 3 },
      { id: 'job-2', status: 'failed', attempts: 0, maxAttempts: 3 },
    ];
    dbExecute.mockResolvedValueOnce(stuckRows);
    scheduleRetryMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ scheduled: true });

    const result = await runStuckSweep();
    expect(result.markedFailed).toBe(2);
    expect(result.retriesScheduled).toBe(1);
    expect(scheduleRetryMock).toHaveBeenCalledTimes(2);
  });
});
