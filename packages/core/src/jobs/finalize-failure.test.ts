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

const scheduleRetryMock = vi.fn(
  async (..._args: unknown[]) =>
    ({ scheduled: false }) as {
      scheduled: boolean;
      reason?: string;
    },
);
vi.mock('./retry.js', () => ({
  scheduleAutoRetryWithVerify: (...args: unknown[]) => scheduleRetryMock(...args),
}));

// cm:why ISS-823 review blocker — pins the fix ordering: stampRunnerLimit must land BEFORE scheduleAutoRetryWithVerify runs, or the box that just hit the limit still reads as healthy when the retry engine checks all_devices_exhausted
let callOrder: string[] = [];
const stampRunnerLimitMock = vi.fn(async (..._args: unknown[]) => {
  callOrder.push('stampRunnerLimit');
});
vi.mock('../runners/apply-runner-limit.js', () => ({
  stampRunnerLimit: (...args: unknown[]) => stampRunnerLimitMock(...args),
}));

// cm:edge contract -> packages/core/src/skills/reconcile-service.ts — its static import chain reaches queue/boss.ts, whose top-level env import throws without DB env (BLOCKER AA).
const failReconcileRunMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../skills/reconcile-service.js', () => ({
  failReconcileRunForFailedJob: (...args: unknown[]) => failReconcileRunMock(...args),
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
const updateSetMock = vi.fn((_values: unknown) => undefined);

// cm:why the jsonb-merge value is a drizzle `sql` fragment holding its interpolation as a Param, and the object graph is circular — so the payload is probed by walking it rather than by JSON.stringify
function mentions(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((v) => mentions(v, needle, seen));
}
vi.mock('../db/client.js', () => ({
  db: {
    select: () => selectChain(),
    update: () => ({
      set: (values: unknown) => {
        updateSetMock(values);
        return { where: async () => undefined };
      },
    }),
  },
}));

const applyTransitionMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../issues/apply-transition.js', () => ({
  applyStatusTransition: (...args: unknown[]) => applyTransitionMock(...args),
}));

const closeRunMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: (...args: unknown[]) => closeRunMock(...args),
}));

// cm:edge contract -> packages/core/src/notifications/routes.ts — its static import chain validates env vars at load time (same pitfall as reconcile-service.ts above); mock the entry point instead.
const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...args),
}));

const JOB_TYPE_ENTRY_STATUS: Record<string, string> = {
  triage: 'open',
  clarify: 'confirmed',
  plan: 'clarified',
  code: 'approved',
  review: 'developed',
  test: 'testing',
  fix: 'reopen',
  release: 'released',
};
const JOB_TYPE_INFLIGHT_STATUS: Record<string, string> = {
  code: 'in_progress',
  fix: 'in_progress',
};
const JOB_TYPE_EXPECTED_EXIT_STATUS: Record<string, string[]> = {
  code: ['developed'],
  fix: ['developed'],
  plan: ['approved'],
  review: ['testing', 'reopen'],
  test: ['released', 'reopen', 'tested'],
};
// ISS-702 — real classifyVerdict semantics, mirrored here so this suite stays
// a pure unit test of finalize-failure.ts without importing recovery-verifier.js.
function classifyVerdict(
  currentStatus: string,
  jobType: string,
): 'advanced' | 'pending' | 'reverted' {
  const entry = JOB_TYPE_ENTRY_STATUS[jobType];
  if (entry && currentStatus === entry) return 'pending';
  if (JOB_TYPE_INFLIGHT_STATUS[jobType] === currentStatus) return 'pending';
  const exits = JOB_TYPE_EXPECTED_EXIT_STATUS[jobType] ?? [];
  if (exits.includes(currentStatus)) return 'advanced';
  if (currentStatus === 'released' || currentStatus === 'closed') return 'advanced';
  if (!entry) return 'pending';
  return 'reverted';
}
vi.mock('../pipeline/recovery-verifier.js', () => ({
  JOB_TYPE_ENTRY_STATUS,
  classifyVerdict,
}));

const hooksEmitMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: (...args: unknown[]) => hooksEmitMock(...args) },
}));

// cm:edge contract -> packages/core/src/jobs/hold.ts — its import chain reaches queue/boss.ts via enqueue.js, whose top-level env import throws without DB env (same pitfall as reconcile-service.ts above); hold.test.ts covers the real thing
const holdJobMock = vi.fn(async (..._args: unknown[]): Promise<string | null> => null);
const holdAutoReleasesMock = vi.fn((..._args: unknown[]) => false);
vi.mock('./hold.js', () => ({
  holdJobForReason: (...args: unknown[]) => holdJobMock(...args),
  holdAutoReleases: (...args: unknown[]) => holdAutoReleasesMock(...args),
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
  callOrder = [];
  scheduleRetryMock.mockImplementation(async () => {
    callOrder.push('scheduleAutoRetryWithVerify');
    return { scheduled: false };
  });
  issueRowMock.mockReturnValue([
    {
      id: 'i1',
      projectId: 'p1',
      status: 'in_progress',
      reopenCount: 0,
      projectCreatedBy: 'owner1',
    },
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
    expect(syncSessionMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }), 'failed', {
      retryPending: true,
    });
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

  // cm:guard assert the LIST of statuses written, not a call count — the revert to entry-status is itself an applyStatusTransition call, so any assertion phrased as "called once" passes unchanged while the `waiting` park is restored alongside it, which is exactly what RFC 0002 INV-1 forbids
  it('holds the job and reverts the issue to entry-status when retry is NOT scheduled — never `waiting`', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'retry_rounds_exhausted' });
    holdJobMock.mockResolvedValueOnce('held-job-1');
    const retry = await finalizeFailedJob(makeJob({ type: 'code' }), {
      error: 'boom',
      exitCode: 1,
    });

    expect(retry.scheduled).toBe(false);
    const [heldJob, heldReason] = holdJobMock.mock.calls[0] ?? [];
    expect((heldJob as { id: string }).id).toBe('j1');
    expect(heldReason).toBe('retry_rounds_exhausted');

    const statusesWritten = applyTransitionMock.mock.calls.map((c) => c[1]);
    expect(statusesWritten).toEqual(['approved']);
    expect(statusesWritten).not.toContain('waiting');

    const wedge = emitWedgeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(wedge.issueId).toBe('i1');
    expect(wedge.entityId).toBe('held-job-1');
  });

  // cm:guard INV-4 — closing the run cascades over `held`, so a close here would cancel the successor this path just created and turn the hold into a silent dead end; that is the one way RFC 0002 lands strictly worse than the park it replaced
  it('does NOT close the run when a job was held', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'all_devices_exhausted' });
    holdJobMock.mockResolvedValueOnce('held-job-2');
    await finalizeFailedJob(makeJob({ type: 'code' }), { error: 'boom' });
    expect(closeRunMock).not.toHaveBeenCalled();
  });

  it('closes the run when the reason holds nothing (a cancel)', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'cancellation_requested' });
    holdJobMock.mockResolvedValueOnce(null);
    await finalizeFailedJob(makeJob({ type: 'code' }), { error: 'boom' });
    expect(closeRunMock).toHaveBeenCalledWith('i1', 'failed');
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('does NOT touch issue state or run for a job with no issue (system job)', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false });
    await finalizeFailedJob(makeJob({ issueId: null }), { error: 'boom' });

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(closeRunMock).not.toHaveBeenCalled();
    expect(publishHealthMock).not.toHaveBeenCalled();
    expect(dispatchTickMock).toHaveBeenCalledWith('p1');
    expect(emitWedgeMock).not.toHaveBeenCalled();
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
      expect(emitWedgeMock).not.toHaveBeenCalled();
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

  it('ISS-702: does NOT revert a stale code job onto `waiting` when a retry is scheduled (parked by a later step)', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true });
    issueRowMock.mockReturnValueOnce([
      { id: 'i1', projectId: 'p1', status: 'waiting', reopenCount: 0, projectCreatedBy: 'owner1' },
    ]);
    await finalizeFailedJob(makeJob({ type: 'code' }), { error: 'boom' });
    expect(applyTransitionMock).not.toHaveBeenCalled();
  });

  it('short-circuits scheduleAutoRetryWithVerify when precomputedRetry is given', async () => {
    const retry = await finalizeFailedJob(makeJob({ type: 'code' }), {
      error: 'resume_failed',
      precomputedRetry: { scheduled: false },
    });

    expect(retry.scheduled).toBe(false);
    expect(scheduleRetryMock).not.toHaveBeenCalled();
    expect(applyTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'i1' }),
      'approved',
      expect.any(Object),
      { skip: true },
    );
    expect(closeRunMock).toHaveBeenCalledWith('i1', 'failed');
  });

  it('ISS-823 review blocker: stamps the runner limit BEFORE calling scheduleAutoRetryWithVerify', async () => {
    await finalizeFailedJob(makeJob({ error: "You've hit your org's monthly spend limit" }), {
      error: "You've hit your org's monthly spend limit",
    });

    expect(stampRunnerLimitMock).toHaveBeenCalled();
    expect(scheduleRetryMock).toHaveBeenCalled();
    expect(callOrder).toEqual(['stampRunnerLimit', 'scheduleAutoRetryWithVerify']);
  });

  it('does not stamp a runner limit for an error text that carries no limit signature', async () => {
    await finalizeFailedJob(makeJob(), { error: 'boom' });

    expect(stampRunnerLimitMock).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['scheduleAutoRetryWithVerify']);
  });

  // cm:guard the copy must not tell the reader to clear anything — a hold that says "clear the park to resume" is the intervention RFC 0002 removed, re-introduced as a sentence
  it('wedge carries hold copy that says the step resumes itself, for all_devices_exhausted', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'all_devices_exhausted' });
    holdJobMock.mockResolvedValueOnce('held-job-3');
    await finalizeFailedJob(makeJob({ type: 'code' }), { error: 'boom' });

    const call = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(call.title).toBe('Step held: every runner is rate-limited');
    expect(call.nextStep).toMatch(/resumes itself/);
    expect(call.nextStep).not.toMatch(/clear the park/);
  });

  // cm:guard a hold that resumes itself must emit NOTHING here — `releaseHeldJobs` re-queues it the moment its condition clears, and `alarmAgedHolds` is the 6h escalation if it does not. Emitting at hold time is what filled the owner's bell with 721 unresolved rows whose own action text said "No action needed" (forge-beta 2026-08-14).
  it('emits NO wedge when the hold will release itself', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'all_devices_exhausted' });
    holdJobMock.mockResolvedValueOnce('held-job-4');
    holdAutoReleasesMock.mockReturnValueOnce(true);
    await finalizeFailedJob(makeJob({ type: 'code' }), { error: 'boom' });

    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('still emits for a hold that waits on a human', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'non_retryable_terminal' });
    holdJobMock.mockResolvedValueOnce('held-job-5');
    holdAutoReleasesMock.mockReturnValueOnce(false);
    await finalizeFailedJob(makeJob({ type: 'code' }), { error: 'boom' });

    const call = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(call.title).toBe('Step held: non-retryable failure');
  });
});
