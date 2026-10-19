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

let callOrder: string[] = [];
const stampRunnerLimitMock = vi.fn(async (..._args: unknown[]) => {
  callOrder.push('stampRunnerLimit');
});
vi.mock('../runners/apply-runner-limit.js', () => ({
  stampRunnerLimit: (...args: unknown[]) => stampRunnerLimitMock(...args),
}));

const failReconcileRunMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../skills/reconcile-service.js', () => ({
  failReconcileRunForFailedJob: (...args: unknown[]) => failReconcileRunMock(...args),
}));

const issueRowMock = vi.fn<() => unknown[]>(() => [{ id: 'i1', projectId: 'p1' }]);
const handoffRowMock = vi.fn<() => unknown[]>(() => []);
// The issue read is the one selecting `projectId`; every other select here is the handoff probe.
function selectChain(fields: Record<string, unknown> = {}) {
  const readsIssue = 'projectId' in fields;
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (readsIssue ? issueRowMock() : handoffRowMock()),
  };
  return chain;
}
const updateSetMock = vi.fn((_values: unknown) => undefined);

function _mentions(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((v) => _mentions(v, needle, seen));
}
vi.mock('../db/client.js', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => selectChain(fields),
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

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...args),
}));

const hooksEmitMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: (...args: unknown[]) => hooksEmitMock(...args) },
}));

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

const kernelTransitionMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock('../lifecycle/transition.js', () => ({
  applyKernelTransition: (...args: unknown[]) => kernelTransitionMock(...args),
}));
vi.mock('../usage-records/materialize.js', () => ({ materializeJobUsage: vi.fn() }));
vi.mock('./session-transcript.js', () => ({ deriveSessionFinal: vi.fn() }));

const { finalizeFailedJob } = await import('./finalize-failure.js');

// Minimal JobRow stand-in — finalizeFailedJob only reads a handful of fields.
function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    projectId: 'p1',
    issueId: 'i1',
    createdBy: 'creator1',
    type: 'custom',
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
  handoffRowMock.mockReturnValue([]);
  kernelTransitionMock.mockResolvedValue([]);
  scheduleRetryMock.mockImplementation(async () => {
    callOrder.push('scheduleAutoRetryWithVerify');
    return { scheduled: false };
  });
  issueRowMock.mockReturnValue([{ id: 'i1', projectId: 'p1' }]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('finalizeFailedJob', () => {
  it('writes no issue status when a retry is scheduled, and does NOT close the run', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true });
    const retry = await finalizeFailedJob(makeJob(), { error: 'boom', exitCode: 1 });

    expect(retry.scheduled).toBe(true);
    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(closeRunMock).not.toHaveBeenCalled();
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

  it.each(['code', 'fix', 'test'])(
    'a historical row of the retired type %s writes no issue status either (ISS-1229)',
    async (type) => {
      scheduleRetryMock.mockResolvedValueOnce({ scheduled: true });
      await finalizeFailedJob(makeJob({ type }), { error: 'crash' });
      expect(applyTransitionMock).not.toHaveBeenCalled();
      expect(closeRunMock).not.toHaveBeenCalled();
    },
  );

  it('holds the job and writes no issue status when retry is NOT scheduled', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'retry_rounds_exhausted' });
    holdJobMock.mockResolvedValueOnce('held-job-1');
    const retry = await finalizeFailedJob(makeJob(), {
      error: 'boom',
      exitCode: 1,
    });

    expect(retry.scheduled).toBe(false);
    const [heldJob, heldReason] = holdJobMock.mock.calls[0] ?? [];
    expect((heldJob as { id: string }).id).toBe('j1');
    expect(heldReason).toBe('retry_rounds_exhausted');

    expect(applyTransitionMock).not.toHaveBeenCalled();

    const wedge = emitWedgeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(wedge.issueId).toBe('i1');
    expect(wedge.entityId).toBe('held-job-1');
  });

  it('does NOT close the run when a job was held', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'all_devices_exhausted' });
    holdJobMock.mockResolvedValueOnce('held-job-2');
    await finalizeFailedJob(makeJob(), { error: 'boom' });
    expect(closeRunMock).not.toHaveBeenCalled();
  });

  it('closes the run when the reason holds nothing (a cancel)', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'cancellation_requested' });
    holdJobMock.mockResolvedValueOnce(null);
    await finalizeFailedJob(makeJob(), { error: 'boom' });
    expect(closeRunMock).toHaveBeenCalledWith('i1', 'failed');
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('does NOT touch issue state or run for a job with no issue (system job)', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false });
    await finalizeFailedJob(makeJob({ issueId: null }), { error: 'boom' });

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(closeRunMock).not.toHaveBeenCalled();
    expect(publishHealthMock).not.toHaveBeenCalled();
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it.each(['completed_via_recovery'])(
    'leaves the issue untouched when verify-first recovery skipped the retry (reason=%s)',
    async (reason) => {
      scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason });
      const retry = await finalizeFailedJob(makeJob(), { error: 'session_lost' });

      expect(retry.scheduled).toBe(false);
      // The issue already recovered — no revert, no waiting, no run close.
      expect(applyTransitionMock).not.toHaveBeenCalled();
      expect(closeRunMock).not.toHaveBeenCalled();
      expect(syncSessionMock).toHaveBeenCalledWith(expect.any(Object), 'failed', {
        retryPending: false,
      });
      expect(emitWedgeMock).not.toHaveBeenCalled();
    },
  );

  it('short-circuits scheduleAutoRetryWithVerify when precomputedRetry is given', async () => {
    const retry = await finalizeFailedJob(makeJob(), {
      error: 'resume_failed',
      precomputedRetry: { scheduled: false },
    });

    expect(retry.scheduled).toBe(false);
    expect(scheduleRetryMock).not.toHaveBeenCalled();
    expect(applyTransitionMock).not.toHaveBeenCalled();
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

  it('wedge carries hold copy that says the step resumes itself, for all_devices_exhausted', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'all_devices_exhausted' });
    holdJobMock.mockResolvedValueOnce('held-job-3');
    await finalizeFailedJob(makeJob(), { error: 'boom' });

    const call = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(call.title).toBe('Step held: every runner is rate-limited');
    expect(call.nextStep).toMatch(/resumes itself/);
    expect(call.nextStep).not.toMatch(/clear the park/);
  });

  it('emits NO wedge when the hold will release itself', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'all_devices_exhausted' });
    holdJobMock.mockResolvedValueOnce('held-job-4');
    holdAutoReleasesMock.mockReturnValueOnce(true);
    await finalizeFailedJob(makeJob(), { error: 'boom' });

    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('still emits for a hold that waits on a human', async () => {
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: false, reason: 'non_retryable_terminal' });
    holdJobMock.mockResolvedValueOnce('held-job-5');
    holdAutoReleasesMock.mockReturnValueOnce(false);
    await finalizeFailedJob(makeJob(), { error: 'boom' });

    const call = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(call.title).toBe('Step held: non-retryable failure');
  });
});

/**
 * ISS-888 item 1 — a turn that finished must not be recorded as failed.
 *
 * The two halves are both correct in isolation and were never joined:
 * `finalize-done.ts` trusts a terminal step-handoff over the runner's exit
 * detection, and `prompt/facts/registry.ts` only asks for a handoff on the
 * stages that have a schema. `drive` — the whole autonomous driver turn — had
 * no schema, so it could not produce the one signal core accepts, and every
 * lost result event on an autonomous project became a full re-run. Measured on
 * ISS-874: two `[NO_RESULT_CLEAN_EXIT]` failures inside one hour, both after
 * the issue had already moved and a comment had already posted.
 */
describe('ISS-888 — a completed drive turn is not retried', () => {
  const driveJob = () =>
    makeJob({
      type: 'drive',
      pipelineRunId: 'run1',
      dispatchedAt: new Date('2026-08-29T15:00:00Z'),
      error: '[NO_RESULT_CLEAN_EXIT] claude exited 0 before emitting a result event',
      failureKind: 'transient-cc',
    });

  it('a drive turn that wrote its handoff is marked done, and NO retry is scheduled', async () => {
    handoffRowMock.mockReturnValue([{ id: 'h1' }]);
    kernelTransitionMock.mockResolvedValue([
      { ...driveJob(), status: 'done', exitCode: 0, error: null },
    ]);

    const retry = await finalizeFailedJob(driveJob(), {
      error: '[NO_RESULT_CLEAN_EXIT] claude exited 0 before emitting a result event',
    });

    expect(retry).toEqual({ scheduled: false, reason: 'completed_via_handoff' });
    expect(scheduleRetryMock).not.toHaveBeenCalled();
    expect(kernelTransitionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'done', reason: 'completed_via_handoff' }),
    );
  });

  it('a drive turn that died before writing its handoff still retries', async () => {
    handoffRowMock.mockReturnValue([]);
    scheduleRetryMock.mockResolvedValueOnce({ scheduled: true });

    const retry = await finalizeFailedJob(driveJob(), { error: '[NO_RESULT_CLEAN_EXIT] x' });

    expect(retry.scheduled).toBe(true);
    expect(scheduleRetryMock).toHaveBeenCalled();
  });
});
