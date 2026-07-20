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
const updateSet = vi.fn((..._args: unknown[]) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

// ISS-450 — deriveCcStartupSignals queries job_events counts. Tests set
// `ccSignalRow` to simulate the failed job's event stream.
let ccSignalRow: { total: number; toolCalls: number; messages: number } = {
  total: 0,
  toolCalls: 0,
  messages: 0,
};
const dbSelect = vi.fn(() => ({
  from: () => ({ where: async () => [ccSignalRow] }),
}));

vi.mock('../db/client.js', () => ({
  db: { insert: dbInsert, update: dbUpdate, select: () => dbSelect() },
}));

const enqueueMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('./enqueue.js', () => ({
  enqueueJob: (...args: unknown[]) => enqueueMock(...args),
}));

const verifyRecoveryMock = vi.fn(async (..._args: unknown[]) => 'pending');
vi.mock('../pipeline/recovery-verifier.js', () => ({
  verifyRecovery: (...args: unknown[]) => verifyRecoveryMock(...(args as [never])),
}));

// Round-robin candidate set. Default: a healthy 3-device project.
const onlineDevicesMock = vi.fn(async (..._args: unknown[]) => ['device-A', 'device-B', 'device-C']);
vi.mock('../runners/select.js', () => ({
  onlineCapableDeviceIds: (...a: unknown[]) => onlineDevicesMock(...(a as [never])),
}));

const incrementRecoveryStatsMock = vi.fn(async (..._args: unknown[]) => undefined);
const incrementAutoRetryCountMock = vi.fn(async (..._args: unknown[]) => undefined);
const markSessionTerminalMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../agent-sessions/recovery-stats.js', () => ({
  incrementRecoveryStats: (...a: unknown[]) => incrementRecoveryStatsMock(...(a as [never])),
  incrementAutoRetryCount: (...a: unknown[]) => incrementAutoRetryCountMock(...(a as [never])),
  markSessionTerminal: (...a: unknown[]) => markSessionTerminalMock(...(a as [never])),
}));

const publishMock = vi.fn(async (..._args: unknown[]) => undefined);
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

const { scheduleAutoRetryWithVerify, RETRY_COOLDOWN_MS, RETRY_MAX_ROUNDS } = await import(
  './retry.js'
);

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
  deviceId: 'device-A',
  retryOf: null,
  error: 'ECONNRESET',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  insertReturning.mockReset();
  verifyRecoveryMock.mockResolvedValue('pending');
  onlineDevicesMock.mockResolvedValue(['device-A', 'device-B', 'device-C']);
  ccSignalRow = { total: 0, toolCalls: 0, messages: 0 };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleAutoRetryWithVerify — per-class policy (ISS-450)', () => {
  it('schedules a retry with the uniform 60s cooldown', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    const result = await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(true);
    expect(result.newJobId).toBe('j2');

    const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.retryOf).toBe('j1');
    expect(inserted.attempts).toBe(2);
    expect(inserted.status).toBe('queued');
    // ISS-434 — the clone must NOT carry the parent's (terminal) session: it is
    // born NULL so ensureAgentSessionForJob re-links + resets at dispatch.
    expect(inserted.agentSessionId).toBeUndefined();
    expect(inserted.retryAfterAt).toEqual(new Date(FIXED_NOW + RETRY_COOLDOWN_MS));

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j2' }), {
      startAfterSeconds: 60,
    });
  });

  it('ISS-434 — clone never inherits a (terminal) session even though stats still use the parent link', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    // baseJob.agentSessionId='s1' is the parent's terminal session.
    await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    // The clone must carry no session link (born NULL) — otherwise
    // reconcileOrphanedJobs reaps it session_lost on the next sweeper tick.
    expect('agentSessionId' in inserted ? inserted.agentSessionId : undefined).toBeUndefined();
    // Display-only recovery stats still target the PARENT session, unaffected.
    expect(incrementRecoveryStatsMock).toHaveBeenCalledWith('s1', expect.any(String));
    expect(incrementAutoRetryCountMock).toHaveBeenCalledWith('s1');
  });

  it('ALWAYS uses 60s — ignores any Retry-After hint (no per-error handling)', async () => {
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
    expect(inserted.retryAfterAt).toEqual(new Date(FIXED_NOW + 60_000));
    expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), { startAfterSeconds: 60 });
  });

  it('does NOT retry a `code` classification (non_retryable_code)', async () => {
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, error: 'invalid_request_error' } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('non_retryable_code');
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('honours a pre-persisted failureKind=code without reclassifying', async () => {
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, error: 'whatever text', failureKind: 'code' } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('non_retryable_code');
  });

  it('RETRIES an infra classification (401 → infra under v3)', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    const result = await scheduleAutoRetryWithVerify(
      { ...baseJob, error: '401 Unauthorized' } as never,
      'crashed',
    );
    expect(result.scheduled).toBe(true);
  });

  it('RETRIES an unmapped failure (infra + needsReview fallback)', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
    const r1 = await scheduleAutoRetryWithVerify(
      { ...baseJob, error: "You've hit your weekly limit" } as never,
      'limit',
    );
    expect(r1.scheduled).toBe(true);
  });

  describe('transient-cc — immediate different-device failover (ISS-402)', () => {
    it('rotates straight to another device with zero cooldown', async () => {
      ccSignalRow = { total: 2, toolCalls: 0, messages: 2 };
      insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
      const result = await scheduleAutoRetryWithVerify(
        { ...baseJob, deviceId: 'device-A', error: 'Agent completed with errors' } as never,
        'cc-died',
      );
      expect(result.scheduled).toBe(true);
      const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
      const auto = (inserted.payload as Record<string, unknown>)._autoRetry as Record<
        string,
        unknown
      >;
      expect(auto.target).toBe('device-B'); // NOT device-A
      expect(auto.done).toContain('device-A');
      expect(inserted.retryAfterAt).toEqual(new Date(FIXED_NOW)); // no cooldown
      expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), { startAfterSeconds: 0 });
    });

    it('text fallback (Unknown command) also routes to failover', async () => {
      insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
      const result = await scheduleAutoRetryWithVerify(
        { ...baseJob, deviceId: 'device-A', error: 'Unknown command: /forge-review' } as never,
        'unknown-cmd',
      );
      expect(result.scheduled).toBe(true);
      const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
      const auto = (inserted.payload as Record<string, unknown>)._autoRetry as Record<
        string,
        unknown
      >;
      expect(auto.target).toBe('device-B');
      expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), { startAfterSeconds: 0 });
    });

    it('falls back to same-device + standard cooldown when no other device is online', async () => {
      ccSignalRow = { total: 2, toolCalls: 0, messages: 1 };
      onlineDevicesMock.mockResolvedValue(['device-A']);
      insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
      const result = await scheduleAutoRetryWithVerify(
        { ...baseJob, deviceId: 'device-A', error: 'Agent completed with errors' } as never,
        'cc-died',
      );
      expect(result.scheduled).toBe(true);
      const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
      const auto = (inserted.payload as Record<string, unknown>)._autoRetry as Record<
        string,
        unknown
      >;
      expect(auto.target).toBe('device-A');
      expect(inserted.retryAfterAt).toEqual(new Date(FIXED_NOW + RETRY_COOLDOWN_MS));
      expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), { startAfterSeconds: 60 });
    });

    it('still respects the RETRY_MAX_ROUNDS budget', async () => {
      ccSignalRow = { total: 2, toolCalls: 0, messages: 1 };
      onlineDevicesMock.mockResolvedValue(['device-A']);
      const result = await scheduleAutoRetryWithVerify(
        {
          ...baseJob,
          deviceId: 'device-A',
          error: 'Agent completed with errors',
          payload: {
            _autoRetry: { round: RETRY_MAX_ROUNDS, target: 'device-A', tries: 1, done: [] },
          },
        } as never,
        'cc-died',
      );
      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe('retry_rounds_exhausted');
    });
  });

  it('skips retry + marks completed_via_recovery when verifier says advanced', async () => {
    verifyRecoveryMock.mockResolvedValueOnce('advanced');
    const result = await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('completed_via_recovery');
    expect(dbInsert).not.toHaveBeenCalled();
    expect(markSessionTerminalMock).toHaveBeenCalledWith('s1', 'completed_via_recovery');
  });

  it('skips retry + marks cancelled_stale when verifier says reverted', async () => {
    verifyRecoveryMock.mockResolvedValueOnce('reverted');
    const result = await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('cancelled_stale');
    expect(markSessionTerminalMock).toHaveBeenCalledWith('s1', 'cancelled_stale');
  });

  it('ISS-702: fails safe to verify_unavailable (no retry) when verifyRecovery throws', async () => {
    verifyRecoveryMock.mockRejectedValueOnce(new Error('db outage'));
    const result = await scheduleAutoRetryWithVerify({ ...baseJob } as never, 'crashed');
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('verify_unavailable');
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

  it('increments recoveryStats even for a non-retryable code failure', async () => {
    await scheduleAutoRetryWithVerify(
      { ...baseJob, error: 'invalid_request_error' } as never,
      'crashed',
    );
    expect(incrementRecoveryStatsMock).toHaveBeenCalledWith('s1', 'code');
    expect(publishMock).toHaveBeenCalledWith('p1', 's1');
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
    expect(setArg?.failureKind).toBe('infra');
  });

  describe('round-robin rotation state', () => {
    it('first failure STAYS on the same device for its 3 tries', async () => {
      insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
      await scheduleAutoRetryWithVerify({ ...baseJob, deviceId: 'device-A' } as never, 'x');
      const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(inserted.payload).toEqual({
        skill: 'forge-plan',
        _autoRetry: { round: 1, target: 'device-A', tries: 2, done: [] },
      });
    });

    it('rotates to the next online device after 3 tries on a device', async () => {
      insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
      await scheduleAutoRetryWithVerify(
        {
          ...baseJob,
          deviceId: 'device-A',
          payload: {
            skill: 'forge-plan',
            _autoRetry: { round: 1, target: 'device-A', tries: 3, done: [] },
          },
        } as never,
        'x',
      );
      const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(inserted.payload).toEqual({
        skill: 'forge-plan',
        _autoRetry: { round: 1, target: 'device-B', tries: 1, done: ['device-A'] },
      });
    });

    it('advances to the next round (resets done) when every device is exhausted', async () => {
      insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
      await scheduleAutoRetryWithVerify(
        {
          ...baseJob,
          deviceId: 'device-C',
          payload: {
            _autoRetry: { round: 1, target: 'device-C', tries: 3, done: ['device-A', 'device-B'] },
          },
        } as never,
        'x',
      );
      const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(inserted.payload).toEqual({
        _autoRetry: { round: 2, target: 'device-A', tries: 1, done: [] },
      });
    });

    it('stops (parks) after RETRY_MAX_ROUNDS full sweeps', async () => {
      const result = await scheduleAutoRetryWithVerify(
        {
          ...baseJob,
          deviceId: 'device-C',
          payload: {
            _autoRetry: {
              round: RETRY_MAX_ROUNDS,
              target: 'device-C',
              tries: 3,
              done: ['device-A', 'device-B'],
            },
          },
        } as never,
        'x',
      );
      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe('retry_rounds_exhausted');
      expect(dbInsert).not.toHaveBeenCalled();
    });

    it('preserves prior payload keys when writing rotation state', async () => {
      insertReturning.mockResolvedValueOnce([{ id: 'j2' }]);
      await scheduleAutoRetryWithVerify(
        {
          ...baseJob,
          deviceId: 'device-A',
          payload: { skill: 'forge-plan', custom: 'keep-me' },
        } as never,
        'x',
      );
      const inserted = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(inserted.payload).toEqual({
        skill: 'forge-plan',
        custom: 'keep-me',
        _autoRetry: { round: 1, target: 'device-A', tries: 2, done: [] },
      });
    });
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
