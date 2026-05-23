import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertReturning = vi.fn();
const insertValues = vi.fn();
const dbInsert = vi.fn(() => ({
  values: (v: unknown) => {
    insertValues(v);
    return { returning: insertReturning };
  },
}));

const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: { insert: dbInsert, update: dbUpdate },
}));

const enqueueMock = vi.fn(async () => {});
vi.mock('./enqueue.js', () => ({
  enqueueJob: (...args: unknown[]) => enqueueMock(...args),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { scheduleAutoRetryOnce } = await import('./retry.js');

type JobRow = Record<string, unknown>;

const baseJob: JobRow = {
  id: 'j1',
  projectId: 'p1',
  issueId: 'i1',
  pipelineRunId: 'r1',
  createdBy: 'u1',
  type: 'plan',
  payload: { skill: 'forge-plan' },
  modelTier: null,
  status: 'failed',
  attempts: 1,
  cancellationRequested: false,
  failureKind: null,
  error: 'ECONNRESET',
};

describe('scheduleAutoRetryOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertReturning.mockReset();
  });

  it('schedules a single auto-retry for a transient failure', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    const result = await scheduleAutoRetryOnce({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(true);
    expect(result.newJobId).toBe('j2');
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j2' }),
      { startAfterSeconds: 60 },
    );

    const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.retryOf).toBe('j1');
    expect(inserted.attempts).toBe(2);
    expect(inserted.status).toBe('queued');
  });

  it('does NOT retry when classifier returns permanent', async () => {
    const result = await scheduleAutoRetryOnce(
      { ...baseJob, error: 'invalid_request_error' } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('classifier:permanent');
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does NOT retry when classifier returns unknown (operator decides)', async () => {
    const result = await scheduleAutoRetryOnce(
      { ...baseJob, error: 'mystery glitch' } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('classifier:unknown');
  });

  it('does NOT retry past the 1-retry budget', async () => {
    const result = await scheduleAutoRetryOnce(
      { ...baseJob, attempts: 2 } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('retry_budget_exhausted');
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('does NOT retry a cancelled job', async () => {
    const result = await scheduleAutoRetryOnce(
      { ...baseJob, cancellationRequested: true } as never,
      'cancelled',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('cancellation_requested');
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('writes classification onto the failed job when not already set', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    await scheduleAutoRetryOnce({ ...baseJob } as never, 'crashed');
    expect(updateSet).toHaveBeenCalled();
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(setArg?.failureKind).toBe('transient');
  });

  it('swallows enqueue errors so the retry row is still created', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    enqueueMock.mockImplementationOnce(async () => {
      throw new Error('pg-boss down');
    });
    const result = await scheduleAutoRetryOnce({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(true);
    expect(result.newJobId).toBe('j2');
  });
});
