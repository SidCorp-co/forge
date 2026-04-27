import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateReturning = vi.fn(async () => []);
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: { update: dbUpdate },
}));

const scheduleRetry = vi.fn(async () => ({ scheduled: true, newJobId: 'retry-id' }));
vi.mock('./retry.js', () => ({
  scheduleRetry: (...args: unknown[]) => scheduleRetry(...(args as [never, never])),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => undefined),
    work: vi.fn(async () => 'wid'),
    schedule: vi.fn(async () => undefined),
  },
}));

const { runQueuedSweep } = await import('./queued-watchdog.js');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runQueuedSweep', () => {
  it('returns zeros when no jobs are stale-queued', async () => {
    updateReturning.mockResolvedValueOnce([]);
    const r = await runQueuedSweep();
    expect(r).toEqual({
      markedFailed: 0,
      retriesScheduled: 0,
      durationMs: expect.any(Number),
    });
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it('marks stale-queued jobs failed with transient classification', async () => {
    updateReturning.mockResolvedValueOnce([
      { id: 'j1', status: 'failed', error: 'queued > 600s', attempts: 1, maxAttempts: 3 },
    ]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(1);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        failureKind: 'transient',
        failureReason: expect.stringContaining('pg-boss'),
        classifierVersion: 1,
      }),
    );
  });

  it('schedules a retry per stale job and counts the successes', async () => {
    updateReturning.mockResolvedValueOnce([
      { id: 'j1', attempts: 1, maxAttempts: 3 },
      { id: 'j2', attempts: 1, maxAttempts: 3 },
    ]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(2);
    expect(r.retriesScheduled).toBe(2);
    expect(scheduleRetry).toHaveBeenCalledTimes(2);
  });

  it('does not crash when scheduleRetry throws — leaves the row failed', async () => {
    updateReturning.mockResolvedValueOnce([
      { id: 'j1', attempts: 1, maxAttempts: 3 },
      { id: 'j2', attempts: 1, maxAttempts: 3 },
    ]);
    scheduleRetry.mockRejectedValueOnce(new Error('boss down')).mockResolvedValueOnce({
      scheduled: true,
      newJobId: 'r2',
    });
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(2);
    expect(r.retriesScheduled).toBe(1);
  });
});
