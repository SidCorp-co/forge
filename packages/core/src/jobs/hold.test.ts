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

vi.mock('../db/client.js', () => ({
  db: {
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
  },
}));

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

// cm:edge contract -> packages/core/src/jobs/retry.ts — the literal MUST equal AUTO_RETRY_PAYLOAD_KEY there; hold.ts imports the real constant, and this stub exists only because that module's import chain validates DB env at load time
vi.mock('./retry.js', () => ({ AUTO_RETRY_PAYLOAD_KEY: '_autoRetry' }));

const {
  AUTO_RELEASE_REASONS,
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
  // cm:guard these five are the mechanical no-retry outcomes and the list must stay closed — a reason added here stops asking a human a question, so anything representing a human decision (a plan to approve, a missing test account) belongs on issues.status via the agent, never here
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

  // cm:guard a condition-checked reason MUST insert with retryAfterAt unset — the release pass gates on that column, so a backoff here delays a capacity recovery the fleet already reported
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

  // cm:guard a permanent hold must NOT advertise a retry — `retry_after_at` was stamped on exactly these reasons and on none of the ones that use it, so the row claimed a retry 10 minutes out that no code path would ever perform (seen live on 4 jobs, 2026-08-14)
  it('a permanent hold stores no retry timestamp', async () => {
    await holdJobForReason(makeJob(), 'non_retryable_terminal');
    const written = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.retryAfterAt).toBeUndefined();
  });

  // cm:guard `verify_unavailable` must arm auto-release AND carry the backoff — HOLD_RECHECK_MS and conditionCleared's fallback were both written for this reason while the autoRelease flag blocked it, so the operator was told "no action needed, it re-checks itself" about a hold that never re-checked
  it('a time-checked reason arms auto-release behind a backoff', async () => {
    const before = Date.now();
    await holdJobForReason(makeJob(), 'verify_unavailable');
    const written = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(readHoldState(written.payload)?.autoRelease).toBe(true);
    const retryAt = written.retryAfterAt as Date;
    expect(retryAt).toBeInstanceOf(Date);
    expect(retryAt.getTime()).toBeGreaterThanOrEqual(before + HOLD_RECHECK_MS);
  });

  // cm:guard this is the loop bound (RFC 0002) — without it a flapping fleet holds, releases with a fresh rotation, fails, and holds again forever, spending a full round budget per flap
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

  // cm:guard this is the release the feature always claimed and never performed — the candidate query returned the row (its backoff had passed) and the autoRelease guard then dropped it, so a DB blip held the step forever. It must re-queue with NO condition lookup: the timer was the whole gate.
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

  // cm:guard AUTO_RELEASE_REASONS must stay derived from the two lanes — a reason in the union with no lane would reach conditionCleared's fallback, and a fallback of `true` there auto-releases it into the very failure it recorded
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

  // cm:guard the released row must carry a FRESH rotation — a payload still holding the exhausted `_autoRetry` state fails on its first attempt and holds again with auto-release already spent, so the recovery buys one attempt instead of a round budget
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

  // cm:guard a throwing condition check must leave the job HELD, never release it — releasing on an unreadable condition dispatches into the failure the hold exists to absorb, and the pass would do it again every tick
  it('a condition check that throws leaves the job held', async () => {
    selectRows.mockReturnValue([heldRow()]);
    capableMock.mockRejectedValue(new Error('runner table unreachable'));
    expect(await releaseHeldJobs('p1')).toBe(0);
    expect(updateSet).not.toHaveBeenCalled();
  });
});
