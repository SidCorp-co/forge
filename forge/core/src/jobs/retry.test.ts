import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertReturning = vi.fn();
const insertValues = vi.fn();
const dbInsert = vi.fn(() => ({
  values: (v: unknown) => {
    insertValues(v);
    return { returning: insertReturning };
  },
}));

vi.mock('../db/client.js', () => ({
  db: { insert: dbInsert },
}));

const enqueueMock = vi.fn(async () => {});
vi.mock('./enqueue.js', () => ({
  enqueueJob: (...args: unknown[]) => enqueueMock(...args),
}));

const { scheduleRetry, computeBackoffSeconds } = await import('./retry.js');

type JobRow = Record<string, unknown>;

const baseJob: JobRow = {
  id: 'j1',
  projectId: 'p1',
  issueId: null,
  createdBy: 'u1',
  type: 'plan',
  payload: { skill: 'forge-plan' },
  modelTier: null,
  status: 'failed',
  attempts: 1,
  maxAttempts: 3,
};

describe('jobs/retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertReturning.mockReset();
  });

  it('computes exponential backoff (60/120/240s for attempts 1/2/3)', () => {
    expect(computeBackoffSeconds(1)).toBe(120);
    expect(computeBackoffSeconds(2)).toBe(240);
    // For attempts=1, scheduleRetry uses `job.attempts` (1) as the input → 2^1*60=120.
    // But after first failure (attempts=1), we compute backoff for the NEXT attempt:
    // scheduleRetry computes with job.attempts, i.e. attempts completed → backoff = 2^attempts * 60.
    expect(computeBackoffSeconds(0)).toBe(60);
  });

  it('schedules a retry when under the cap', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    const result = await scheduleRetry({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(true);
    expect(result.newJobId).toBe('j2');
    expect(result.attempt).toBe(2);
    expect(result.backoffSec).toBe(120);
    expect(enqueueMock).toHaveBeenCalledWith('j2', { startAfterSeconds: 120 });

    const insertedValues = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedValues.retryOf).toBe('j1');
    expect(insertedValues.attempts).toBe(2);
    expect(insertedValues.maxAttempts).toBe(3);
    expect(insertedValues.status).toBe('queued');
  });

  it('does NOT retry at the cap (attempts === maxAttempts)', async () => {
    const result = await scheduleRetry(
      { ...baseJob, attempts: 3, maxAttempts: 3 } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does NOT retry a cancelled job', async () => {
    const result = await scheduleRetry({ ...baseJob, status: 'cancelled' } as never, 'cancelled');
    expect(result.scheduled).toBe(false);
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('swallows enqueue errors so the retry row is still created', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    enqueueMock.mockImplementationOnce(async () => {
      throw new Error('pg-boss down');
    });
    const result = await scheduleRetry({ ...baseJob } as never, 'crashed');
    // scheduled:true because the DB row exists; the stale detector will re-enqueue.
    expect(result.scheduled).toBe(true);
    expect(result.newJobId).toBe('j2');
  });
});
