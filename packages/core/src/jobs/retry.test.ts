import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const verifyRecoveryMock = vi.fn(async () => 'pending');
vi.mock('../pipeline/recovery-verifier.js', () => ({
  verifyRecovery: (...args: unknown[]) => verifyRecoveryMock(...(args as [never])),
}));

const incrementRecoveryStatsMock = vi.fn(async () => undefined);
const incrementAutoRetryCountMock = vi.fn(async () => undefined);
const markSessionTerminalMock = vi.fn(async () => undefined);
vi.mock('../agent-sessions/recovery-stats.js', () => ({
  incrementRecoveryStats: (...a: unknown[]) => incrementRecoveryStatsMock(...(a as [never])),
  incrementAutoRetryCount: (...a: unknown[]) => incrementAutoRetryCountMock(...(a as [never])),
  markSessionTerminal: (...a: unknown[]) => markSessionTerminalMock(...(a as [never])),
}));

const publishMock = vi.fn(async () => undefined);
vi.mock('../agent-sessions/recovery-publish.js', () => ({
  publishSessionRecoveryChanged: (...a: unknown[]) => publishMock(...(a as [never])),
}));

const addBreadcrumbMock = vi.fn();
vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: (...a: unknown[]) => addBreadcrumbMock(...(a as [never])) },
  isSentryEnabled: () => true,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { scheduleAutoRetryWithVerify } = await import('./retry.js');

type JobRow = Record<string, unknown>;

const FIXED_NOW = new Date('2026-05-23T12:00:00.000Z').getTime();

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
  failureMeta: null,
  agentSessionId: 's1',
  error: 'ECONNRESET',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  insertReturning.mockReset();
  verifyRecoveryMock.mockResolvedValue('pending');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleAutoRetryWithVerify', () => {
  it('schedules a single auto-retry for a transient failure with the 60s floor', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    const result = await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(true);
    expect(result.newJobId).toBe('j2');

    const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.retryOf).toBe('j1');
    expect(inserted.attempts).toBe(2);
    expect(inserted.status).toBe('queued');
    expect(inserted.agentSessionId).toBe('s1');
    expect(inserted.retryAfterAt).toEqual(new Date(FIXED_NOW + 60000));

    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j2' }),
      { startAfterSeconds: 60 },
    );
  });

  it('honours classifier Retry-After hint above the floor', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    await scheduleAutoRetryWithVerify(
      {
        ...baseJob,
        error: '429 too many requests',
        failureMeta: { headers: { 'retry-after': '600' } },
      } as never,
      'rate-limited',
    );
    const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.retryAfterAt).toEqual(new Date(FIXED_NOW + 600 * 1000));
    expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), { startAfterSeconds: 600 });
  });

  it('uses 60s floor when Retry-After is below it', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    await scheduleAutoRetryWithVerify(
      {
        ...baseJob,
        error: '429',
        failureMeta: { headers: { 'retry-after': '5' } },
      } as never,
      'rate-limited',
    );
    const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.retryAfterAt).toEqual(new Date(FIXED_NOW + 60000));
  });

  it('skips retry and marks completed_via_recovery when verifier says advanced', async () => {
    verifyRecoveryMock.mockResolvedValueOnce('advanced');
    const result = await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('completed_via_recovery');
    expect(dbInsert).not.toHaveBeenCalled();
    expect(markSessionTerminalMock).toHaveBeenCalledWith('s1', 'completed_via_recovery');
    expect(
      addBreadcrumbMock.mock.calls.some(
        (c) =>
          (c[0] as { category?: string }).category === 'session.recovery_skipped' &&
          ((c[0] as { data?: Record<string, unknown> }).data?.currentStatus === 'advanced'),
      ),
    ).toBe(true);
  });

  it('skips retry and marks cancelled_stale when verifier says reverted', async () => {
    verifyRecoveryMock.mockResolvedValueOnce('reverted');
    const result = await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('cancelled_stale');
    expect(markSessionTerminalMock).toHaveBeenCalledWith('s1', 'cancelled_stale');
  });

  it('does NOT retry when classifier returns permanent', async () => {
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, error: 'invalid_request_error' } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('classifier:permanent');
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('does NOT retry when classifier returns permission (v2 split)', async () => {
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, error: '401 Unauthorized' } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('classifier:permission');
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('DOES retry when classifier returns timeout (v2 split)', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, error: 'ETIMEDOUT' } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(true);
  });

  it('DOES retry once when classifier returns unknown (silent runner death fallback)', async () => {
    // Silent CLI deaths (e.g. Tauri's "Agent completed with errors" fallback
    // when Claude CLI exits non-zero with empty stderr) classify as unknown
    // because no pattern matches. They are usually transient; we attempt one
    // recovery before falling through to manual hold.
    insertReturning.mockResolvedValueOnce([{ id: 'j-unknown-retry' }]);
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, error: 'Agent completed with errors' } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(true);
    expect(result.newJobId).toBe('j-unknown-retry');
  });

  it('exhausts the unknown budget after a single retry (attempts=2)', async () => {
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, error: 'mystery glitch', attempts: 2 } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('retry_budget_exhausted');
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('does NOT retry past the MAX_AUTO_RETRIES budget', async () => {
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, attempts: 4 } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('retry_budget_exhausted');
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('does NOT retry a cancelled job', async () => {
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, cancellationRequested: true } as never,
      'cancelled',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('cancellation_requested');
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('always increments recoveryStats even for non-retryable kinds', async () => {
    await scheduleAutoRetryWithVerify(
      { ...baseJob, error: 'invalid_request_error' } as never,
      'crashed',
    );
    expect(incrementRecoveryStatsMock).toHaveBeenCalledWith('s1', 'permanent');
    expect(publishMock).toHaveBeenCalledWith('p1', 's1');
  });

  it('increments recoveryStats with timeout kind for timeout failures', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    await scheduleAutoRetryWithVerify(
      { ...baseJob, error: 'ETIMEDOUT' } as never,
      'crashed',
    );
    expect(incrementRecoveryStatsMock).toHaveBeenCalledWith('s1', 'timeout');
  });

  it('emits session.recovery_attempted breadcrumb on successful schedule', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(
      addBreadcrumbMock.mock.calls.some(
        (c) => (c[0] as { category?: string }).category === 'session.recovery_attempted',
      ),
    ).toBe(true);
  });

  it('increments autoRetries after scheduling', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(incrementAutoRetryCountMock).toHaveBeenCalledWith('s1');
  });

  it('writes classification onto the failed job when not already set', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(updateSet).toHaveBeenCalled();
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(setArg?.failureKind).toBe('transient');
  });

  it('swallows enqueue errors so the retry row is still created', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    enqueueMock.mockImplementationOnce(async () => {
      throw new Error('pg-boss down');
    });
    const result = await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(true);
    expect(result.newJobId).toBe('j2');
  });
});
