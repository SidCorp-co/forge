/**
 * ISS-280 / ISS-393 — shared failure-finalize path.
 *
 * `finalizeFailedJob` is the single tail used by `/complete`, `/fail`, the
 * dispatcher adapter-fail path, and the sweepers. These tests pin the routing
 * contract after ISS-393 removed the manual-hold model:
 *  (a) a retryable failure reverts the issue to the stage entry-status (so it
 *      re-dispatches via the queued retry) and does NOT close the run;
 *  (b) a non-scheduled retry on an issue-linked job parks the issue at
 *      `waiting` AND reaps the open run;
 *  (c) a verify-first recovery skip touches neither status nor run;
 *  (d) a job with no issue never touches issue state;
 *  (e) every path frees the slot + broadcasts job.failed + emits jobFailed;
 *  (f) a precomputedRetry short-circuits scheduleAutoRetryWithVerify.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scheduleRetryMock = vi.fn(async (..._args: unknown[]) => ({ scheduled: false }) as {
  scheduled: boolean;
  reason?: string;
});
vi.mock('./retry.js', () => ({
  scheduleAutoRetryWithVerify: (...args: unknown[]) => scheduleRetryMock(...args),
}));

// db.select().from().innerJoin().where().limit() → issue+owner row.
const issueRowMock = vi.fn<() => unknown[]>(() => [
  { id: 'i1', projectId: 'p1', status: 'in_progress', reopenCount: 0, projectCreatedBy: 'owner1' },
]);
function selectChain() {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => issueRowMock(),
  };
  return chain;
}
vi.mock('../db/client.js', () => ({
  db: { select: () => selectChain() },
}));

const applyTransitionMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../issues/apply-transition.js', () => ({
  applyStatusTransition: (...args: unknown[]) => applyTransitionMock(...args),
}));

const closeRunMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: (...args: unknown[]) => closeRunMock(...args),
}));

vi.mock('../pipeline/recovery-verifier.js', () => ({
  JOB_TYPE_ENTRY_STATUS: {
    triage: 'open',
    clarify: 'confirmed',
    plan: 'clarified',
    code: 'approved',
    review: 'developed',
    test: 'testing',
    fix: 'reopen',
    release: 'released',
  },
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

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { finalizeFailedJob } = await import('./finalize-failure.js');

// Minimal JobRow stand-in — finalizeFailedJob only reads a handful of fields.
function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    projectId: 'p1',
    issueId: 'i1',
    createdBy: 'creator1',
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
  issueRowMock.mockReturnValue([
    { id: 'i1', projectId: 'p1', status: 'in_progress', reopenCount: 0, projectCreatedBy: 'owner1' },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('finalizeFailedJob', () => {
  it('reverts the issue to entry-status (fix→reopen) when a retry is scheduled, and does NOT close the run', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true });
    const retry = await finalizeFailedJob(makeJob(), { error: 'boom', exitCode: 1 });

    expect(retry.scheduled).toBe(true);
    expect(applyTransitionMock).toHaveBeenCalledTimes(1);
    expect(applyTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'i1' }),
      'reopen',
      expect.objectContaining({ id: 'owner1' }),
      { skip: true },
    );
    expect(closeRunMock).not.toHaveBeenCalled();
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

  it('code job: reverts in_progress → approved on a scheduled retry (ISS-34 repro)', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true });
    await finalizeFailedJob(makeJob({ type: 'code' }), { error: 'crash' });
    expect(applyTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'i1' }),
      'approved',
      expect.any(Object),
      { skip: true },
    );
    expect(closeRunMock).not.toHaveBeenCalled();
  });

  it('parks the issue at `waiting` and reaps the run when retry is NOT scheduled', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false });
    const retry = await finalizeFailedJob(makeJob({ type: 'code' }), { error: 'boom', exitCode: 1 });

    expect(retry.scheduled).toBe(false);
    expect(applyTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'i1' }),
      'waiting',
      expect.objectContaining({ id: 'owner1' }),
      { skip: true },
    );
    expect(closeRunMock).toHaveBeenCalledWith('i1', 'failed');
    expect(syncSessionMock).toHaveBeenCalledWith(expect.any(Object), 'failed', {
      retryPending: false,
    });
  });

  it('does NOT touch issue state or run for a job with no issue (system job)', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false });
    await finalizeFailedJob(makeJob({ issueId: null }), { error: 'boom' });

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(closeRunMock).not.toHaveBeenCalled();
    expect(publishHealthMock).not.toHaveBeenCalled();
    expect(dispatchTickMock).toHaveBeenCalledWith('p1');
  });

  it.each(['completed_via_recovery', 'cancelled_stale'])(
    'leaves the issue untouched when verify-first recovery skipped the retry (reason=%s)',
    async (reason) => {
      scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason });
      const retry = await finalizeFailedJob(makeJob(), { error: 'session_lost' });

      expect(retry.scheduled).toBe(false);
      // The issue already recovered — no revert, no waiting, no run close.
      expect(applyTransitionMock).not.toHaveBeenCalled();
      expect(closeRunMock).not.toHaveBeenCalled();
      expect(dispatchTickMock).toHaveBeenCalledWith('p1');
      expect(syncSessionMock).toHaveBeenCalledWith(expect.any(Object), 'failed', {
        retryPending: false,
      });
    },
  );

  it('does not revert when the issue is already at entry-status (no NO_OP transition)', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true });
    issueRowMock.mockReturnValueOnce([
      { id: 'i1', projectId: 'p1', status: 'reopen', reopenCount: 0, projectCreatedBy: 'owner1' },
    ]);
    await finalizeFailedJob(makeJob({ type: 'fix' }), { error: 'boom' });
    expect(applyTransitionMock).not.toHaveBeenCalled();
  });

  it('short-circuits scheduleAutoRetryWithVerify when precomputedRetry is given', async () => {
    const retry = await finalizeFailedJob(makeJob({ type: 'code' }), {
      error: 'resume_failed',
      precomputedRetry: { scheduled: false },
    });

    expect(retry.scheduled).toBe(false);
    expect(scheduleRetryMock).not.toHaveBeenCalled();
    // precomputed { scheduled:false } + issue → parks at waiting + reaps run.
    expect(applyTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'i1' }),
      'waiting',
      expect.any(Object),
      { skip: true },
    );
    expect(closeRunMock).toHaveBeenCalledWith('i1', 'failed');
  });
});
