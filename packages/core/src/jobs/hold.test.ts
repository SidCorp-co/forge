/**
 * RFC 0002 phase 2 — the hold path's two decisions, isolated from the DB.
 *
 * What is worth pinning here is not that the row is written; it is WHICH
 * reasons hold, which of those can release themselves, and that a lineage
 * spends its auto-release exactly once. Those three are the entire difference
 * between an honest wait and an infinite dispatch loop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertValues = vi.fn();
const updateSet = vi.fn();
const selectRows = vi.fn<() => unknown[]>(() => []);

const dbStub = {
  execute: async () => [],
  transaction: async (fn: (tx: unknown) => unknown) => fn(dbStub),
  insert: () => ({
    values: (v: unknown) => {
      insertValues(v);
      return { returning: async () => [{ id: 'held-1' }] };
    },
  }),
  update: () => ({
    set: (v: unknown) => {
      updateSet(v);
      return {
        where: () => ({
          returning: async () => [{ id: 'held-1', type: 'code', issueId: 'i1' }],
        }),
      };
    },
  }),
  select: () => ({ from: () => ({ where: async () => selectRows() }) }),
};
vi.mock('../db/client.js', () => ({ db: dbStub }));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const enqueueJobMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./enqueue.js', () => ({
  enqueueJob: (...args: unknown[]) => enqueueJobMock(...args),
  enqueueReconcileJob: (...args: unknown[]) => enqueueJobMock(...args),
}));

const budgetMock = vi.fn(async () => ({ action: 'allow' }) as { action: string });
vi.mock('./budget-check.js', () => ({
  checkMonthlyBudget: () => budgetMock(),
}));

const capableMock = vi.fn(async () => [] as string[]);
vi.mock('../runners/select.js', () => ({
  onlineCapableDeviceIds: () => capableMock(),
}));

vi.mock('./stage-overrides.js', () => ({
  resolveStageOverrides: async () => ({ deviceIds: null }),
}));

vi.mock('./retry.js', () => ({ AUTO_RETRY_PAYLOAD_KEY: '_autoRetry' }));

const resolveWedgeMock = vi.fn(async (..._args: unknown[]) => 0);
vi.mock('../pipeline/wedge.js', () => ({
  resolvePipelineWedge: (...args: unknown[]) => resolveWedgeMock(...args),
}));

const {
  AUTO_RELEASE_REASONS,
  buildRequeueUpdate,
  HOLD_PAYLOAD_KEY,
  HOLD_REASONS,
  HOLD_RECHECK_MS,
  holdJobForReason,
  readHoldState,
  releaseHeldJobs,
} = await import('./hold.js');

function makeJob(over: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    projectId: 'p1',
    issueId: 'i1',
    pipelineRunId: 'r1',
    createdBy: 'u1',
    type: 'code',
    payload: {},
    modelTier: 'default',
    attempts: 3,
    failureReason: null,
    retryAfterAt: null,
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: test stand-in for JobRow
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.mockReturnValue([]);
  budgetMock.mockResolvedValue({ action: 'allow' });
  capableMock.mockResolvedValue([]);
});

describe('HOLD_REASONS', () => {
  it('covers exactly the mechanical no-retry reasons, and nothing that concludes anything', () => {
    expect([...HOLD_REASONS].sort()).toEqual([
      'all_devices_exhausted',
      'monthly_budget_exhausted',
      'non_retryable_terminal',
      'retry_rounds_exhausted',
      'verify_unavailable',
    ]);
    for (const conclusion of [
      'cancellation_requested',
      'completed_via_recovery',
      'cancelled_stale',
    ])
      expect(HOLD_REASONS.has(conclusion)).toBe(false);
  });
});

describe('holdJobForReason', () => {
  it('refuses a reason that is not a hold reason', async () => {
    expect(await holdJobForReason(makeJob(), 'cancellation_requested')).toBeNull();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('inserts a successor at held carrying the reason, never touching the failed row', async () => {
    const id = await holdJobForReason(makeJob(), 'all_devices_exhausted');
    expect(id).toBe('held-1');
    const written = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.status).toBe('held');
    expect(written.retryOf).toBe('j1');
    expect(written.failureReason).toBe('all_devices_exhausted');
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('a condition-checked reason holds with auto-release armed and no backoff', async () => {
    await holdJobForReason(makeJob(), 'all_devices_exhausted');
    const written = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(readHoldState(written.payload)?.autoRelease).toBe(true);
    expect(written.retryAfterAt).toBeUndefined();
  });

  it('a reason with no re-checkable condition holds with auto-release OFF', async () => {
    await holdJobForReason(makeJob(), 'retry_rounds_exhausted');
    const written = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(readHoldState(written.payload)?.autoRelease).toBe(false);
  });

  it('a permanent hold stores no retry timestamp', async () => {
    await holdJobForReason(makeJob(), 'non_retryable_terminal');
    const written = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.retryAfterAt).toBeUndefined();
  });

  it('a time-checked reason arms auto-release behind a backoff', async () => {
    const before = Date.now();
    await holdJobForReason(makeJob(), 'verify_unavailable');
    const written = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(readHoldState(written.payload)?.autoRelease).toBe(true);
    const retryAt = written.retryAfterAt as Date;
    expect(retryAt).toBeInstanceOf(Date);
    expect(retryAt.getTime()).toBeGreaterThanOrEqual(before + HOLD_RECHECK_MS);
  });

  it('a SECOND hold in the same lineage never re-arms auto-release', async () => {
    const alreadyHeld = makeJob({
      payload: {
        [HOLD_PAYLOAD_KEY]: {
          reason: 'all_devices_exhausted',
          heldAt: '2026-08-13T00:00:00.000Z',
          autoRelease: false,
        },
      },
    });
    await holdJobForReason(alreadyHeld, 'all_devices_exhausted');
    const written = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(readHoldState(written.payload)?.autoRelease).toBe(false);
  });
});

describe('releaseHeldJobs', () => {
  function heldRow(over: Record<string, unknown> = {}) {
    return {
      ...makeJob(),
      id: 'held-1',
      status: 'held',
      payload: {
        [HOLD_PAYLOAD_KEY]: {
          reason: 'all_devices_exhausted',
          heldAt: '2026-08-13T00:00:00.000Z',
          autoRelease: true,
        },
      },
      ...over,
    };
  }

  it('leaves the job held while the condition still holds', async () => {
    selectRows.mockReturnValue([heldRow()]);
    capableMock.mockResolvedValue([]);
    expect(await releaseHeldJobs('p1')).toBe(0);
    expect(updateSet).not.toHaveBeenCalled();
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('releases a time-checked hold once its backoff has passed, without consulting the fleet', async () => {
    selectRows.mockReturnValue([
      heldRow({
        payload: {
          [HOLD_PAYLOAD_KEY]: {
            reason: 'verify_unavailable',
            heldAt: '2026-08-13T00:00:00.000Z',
            autoRelease: true,
          },
        },
      }),
    ]);
    capableMock.mockResolvedValue([]);

    expect(await releaseHeldJobs('p1')).toBe(1);
    expect(capableMock).not.toHaveBeenCalled();
    const written = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.status).toBe('queued');
    expect(written.retryAfterAt).toBeNull();
  });

  it('every auto-releasable reason declares a lane', () => {
    for (const reason of AUTO_RELEASE_REASONS) expect(HOLD_REASONS.has(reason)).toBe(true);
    expect(AUTO_RELEASE_REASONS.has('non_retryable_terminal')).toBe(false);
    expect(AUTO_RELEASE_REASONS.has('retry_rounds_exhausted')).toBe(false);
    expect(AUTO_RELEASE_REASONS.has('verify_unavailable')).toBe(true);
  });

  it('re-queues and enqueues once a capable runner is back', async () => {
    selectRows.mockReturnValue([heldRow()]);
    capableMock.mockResolvedValue(['dev-1']);
    expect(await releaseHeldJobs('p1')).toBe(1);
    const written = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.status).toBe('queued');
    expect(written.retryAfterAt).toBeNull();
    expect(enqueueJobMock).toHaveBeenCalled();
  });

  it('drops the spent retry rotation from the released payload', async () => {
    selectRows.mockReturnValue([
      heldRow({ payload: { ...heldRow().payload, _autoRetry: { round: 10, tries: 3 } } }),
    ]);
    capableMock.mockResolvedValue(['dev-1']);
    await releaseHeldJobs('p1');
    const written = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.payload).not.toHaveProperty('_autoRetry');
  });

  it('never releases a hold whose auto-release is spent, however clear the condition', async () => {
    selectRows.mockReturnValue([
      heldRow({
        payload: {
          [HOLD_PAYLOAD_KEY]: {
            reason: 'retry_rounds_exhausted',
            heldAt: '2026-08-13T00:00:00.000Z',
            autoRelease: false,
          },
        },
      }),
    ]);
    capableMock.mockResolvedValue(['dev-1']);
    budgetMock.mockResolvedValue({ action: 'allow' });
    expect(await releaseHeldJobs('p1')).toBe(0);
  });

  it('keeps a budget hold held until the budget check stops saying pause', async () => {
    selectRows.mockReturnValue([
      heldRow({
        payload: {
          [HOLD_PAYLOAD_KEY]: {
            reason: 'monthly_budget_exhausted',
            heldAt: '2026-08-13T00:00:00.000Z',
            autoRelease: true,
          },
        },
      }),
    ]);
    budgetMock.mockResolvedValue({ action: 'pause' });
    expect(await releaseHeldJobs('p1')).toBe(0);
    budgetMock.mockResolvedValue({ action: 'allow' });
    expect(await releaseHeldJobs('p1')).toBe(1);
  });

  it('a condition check that throws leaves the job held', async () => {
    selectRows.mockReturnValue([heldRow()]);
    capableMock.mockRejectedValue(new Error('runner table unreachable'));
    expect(await releaseHeldJobs('p1')).toBe(0);
    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe('buildRequeueUpdate', () => {
  const now = new Date('2026-08-14T12:00:00.000Z');
  const armed = {
    [HOLD_PAYLOAD_KEY]: {
      reason: 'all_devices_exhausted',
      heldAt: '2026-08-14T06:00:00.000Z',
      autoRelease: true,
    },
  };

  it('spends the auto-release whichever path applies it', () => {
    const patch = buildRequeueUpdate(makeJob({ payload: armed }), now);
    expect(readHoldState(patch.payload)?.autoRelease).toBe(false);
    expect(readHoldState(patch.payload)?.reason).toBe('all_devices_exhausted');
  });

  it('clears the failure verdict and the backoff so the row reads as freshly queued', () => {
    const patch = buildRequeueUpdate(
      makeJob({
        payload: armed,
        failureReason: 'all_devices_exhausted',
        retryAfterAt: new Date('2026-08-14T07:00:00.000Z'),
      }),
      now,
    );
    expect(patch.status).toBe('queued');
    expect(patch.queuedAt).toBe(now);
    expect(patch.retryAfterAt).toBeNull();
    expect(patch.failureReason).toBeNull();
    expect(patch.failureKind).toBeNull();
  });

  it('drops only the spent rotation, preserving the rest of the payload', () => {
    const patch = buildRequeueUpdate(
      makeJob({
        payload: {
          ...armed,
          _autoRetry: { nextRotation: null },
          requiredCapabilities: { git: true },
        },
      }),
      now,
    );
    expect(patch.payload).not.toHaveProperty('_autoRetry');
    expect(patch.payload.requiredCapabilities).toEqual({ git: true });
  });
});
