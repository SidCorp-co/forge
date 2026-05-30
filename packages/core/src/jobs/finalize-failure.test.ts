/**
 * ISS-280 — shared failure-finalize path.
 *
 * `finalizeFailedJob` is the single tail used by `/complete`, `/fail`, and the
 * `reconcileOrphanedJobs` sweeper. These tests pin the routing contract:
 *  (a) a retryable failure schedules an auto-retry and does NOT manual-hold;
 *  (b) a non-scheduled retry on an issue-linked job manual-holds;
 *  (c) every path frees the slot (dispatchTickForProject) + broadcasts
 *      job.failed + emits the jobFailed hook;
 *  (d) a precomputedRetry short-circuits scheduleAutoRetryWithVerify.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scheduleRetryMock = vi.fn(async (..._args: unknown[]) => ({ scheduled: false }) as {
  scheduled: boolean;
  reason?: string;
});
vi.mock('./retry.js', () => ({
  scheduleAutoRetryWithVerify: (...args: unknown[]) => scheduleRetryMock(...args),
}));

const setManualHoldBlockMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/manual-hold.js', () => ({
  setManualHoldBlock: (...args: unknown[]) => setManualHoldBlockMock(...args),
}));

const loadRecoveryStatsMock = vi.fn(async (..._args: unknown[]) => ({ attempts: 0 }));
vi.mock('../pipeline/recovery-stats.js', () => ({
  loadRecoveryStats: (...args: unknown[]) => loadRecoveryStatsMock(...args),
}));

vi.mock('../pipeline/hold-policy.js', () => ({
  computeHoldUntil: () => new Date('2026-05-30T00:00:00Z'),
}));

const hooksEmitMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: (...args: unknown[]) => hooksEmitMock(...args) },
}));

const syncSessionMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./agent-session-link.js', () => ({
  syncAgentSessionLifecycle: (...args: unknown[]) => syncSessionMock(...args),
}));

const dispatchTickMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./dispatch-tick.js', () => ({
  dispatchTickForProject: (...args: unknown[]) => dispatchTickMock(...args),
}));

const publishHealthMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../issues/pipeline-health.js', () => ({
  publishPipelineHealthChanged: (...args: unknown[]) => publishHealthMock(...args),
}));

const wsPublishMock = vi.fn((..._args: unknown[]) => 0);
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => wsPublishMock(...args) },
}));

const { finalizeFailedJob, mapFailureKindToClassification } = await import('./finalize-failure.js');

// Minimal JobRow stand-in — finalizeFailedJob only reads a handful of fields.
function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    projectId: 'p1',
    issueId: 'i1',
    type: 'fix',
    attempts: 1,
    status: 'failed',
    exitCode: 1,
    error: 'boom',
    failureKind: 'transient',
    failureReason: 'transient blip',
    agentSessionId: 's1',
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test stand-in for JobRow
  } as any;
}

beforeEach(() => {
  scheduleRetryMock.mockResolvedValue({ scheduled: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('finalizeFailedJob', () => {
  it('schedules auto-retry and does NOT manual-hold when retry is scheduled', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true });
    const retry = await finalizeFailedJob(makeJob(), { error: 'boom', exitCode: 1 });

    expect(retry.scheduled).toBe(true);
    expect(scheduleRetryMock).toHaveBeenCalledTimes(1);
    expect(setManualHoldBlockMock).not.toHaveBeenCalled();
    // Slot freed + lifecycle mirrored + broadcast + hook all fire.
    expect(dispatchTickMock).toHaveBeenCalledWith('p1');
    expect(syncSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j1' }),
      'failed',
      { retryPending: true },
    );
    expect(wsPublishMock).toHaveBeenCalledWith(
      'project:p1',
      expect.objectContaining({ event: 'job.failed' }),
    );
    expect(hooksEmitMock).toHaveBeenCalledWith(
      'jobFailed',
      expect.objectContaining({ jobId: 'j1', failureKind: 'transient' }),
    );
    expect(publishHealthMock).toHaveBeenCalledWith('p1', ['i1']);
  });

  it('manual-holds when retry is NOT scheduled and the job has an issue', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false });
    const retry = await finalizeFailedJob(makeJob(), { error: 'boom', exitCode: 1 });

    expect(retry.scheduled).toBe(false);
    expect(loadRecoveryStatsMock).toHaveBeenCalledWith('i1');
    expect(setManualHoldBlockMock).toHaveBeenCalledTimes(1);
    const arg = setManualHoldBlockMock.mock.calls[0]?.[0] as {
      issueId: string;
      context: { classification: { kind: string }; trigger: string };
    };
    expect(arg.issueId).toBe('i1');
    expect(arg.context.trigger).toBe('job_failed');
    expect(arg.context.classification.kind).toBe('transient_network');
    // syncSession told the run is NOT pending a retry.
    expect(syncSessionMock).toHaveBeenCalledWith(expect.any(Object), 'failed', {
      retryPending: false,
    });
  });

  it('does NOT manual-hold or refresh health for a job with no issue (system job)', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false });
    await finalizeFailedJob(makeJob({ issueId: null }), { error: 'boom' });

    expect(setManualHoldBlockMock).not.toHaveBeenCalled();
    expect(publishHealthMock).not.toHaveBeenCalled();
    // Slot is still freed even for system jobs.
    expect(dispatchTickMock).toHaveBeenCalledWith('p1');
  });

  it.each(['completed_via_recovery', 'cancelled_stale'])(
    'does NOT manual-hold when verify-first recovery skipped the retry (reason=%s)',
    async (reason) => {
      scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason });
      const retry = await finalizeFailedJob(makeJob(), { error: 'session_lost' });

      expect(retry.scheduled).toBe(false);
      // The issue already recovered — manual-holding would wedge it (ISS-280 AC2/AC4).
      expect(setManualHoldBlockMock).not.toHaveBeenCalled();
      // ...but the slot is still freed + lifecycle still mirrored.
      expect(dispatchTickMock).toHaveBeenCalledWith('p1');
      expect(syncSessionMock).toHaveBeenCalledWith(expect.any(Object), 'failed', {
        retryPending: false,
      });
    },
  );

  it('short-circuits scheduleAutoRetryWithVerify when precomputedRetry is given', async () => {
    const retry = await finalizeFailedJob(makeJob(), {
      error: 'resume_failed',
      precomputedRetry: { scheduled: false },
    });

    expect(retry.scheduled).toBe(false);
    expect(scheduleRetryMock).not.toHaveBeenCalled();
    // precomputed { scheduled:false } + issue → still manual-holds.
    expect(setManualHoldBlockMock).toHaveBeenCalledTimes(1);
  });
});

describe('mapFailureKindToClassification', () => {
  it('maps transient/timeout → transient_network', () => {
    expect(mapFailureKindToClassification('transient')).toBe('transient_network');
    expect(mapFailureKindToClassification('timeout')).toBe('transient_network');
  });
  it('maps permanent/permission → permanent_invalid', () => {
    expect(mapFailureKindToClassification('permanent')).toBe('permanent_invalid');
    expect(mapFailureKindToClassification('permission')).toBe('permanent_invalid');
  });
  it('maps anything else → unknown', () => {
    expect(mapFailureKindToClassification(null)).toBe('unknown');
    expect(mapFailureKindToClassification('weird')).toBe('unknown');
  });
});
