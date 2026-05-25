import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => {
  const select = vi.fn();
  const update = vi.fn();
  // ISS-40 PR-E — Layer 4 gate runs db.execute against the jobs table.
  // Default to "0 in-flight" so the gate passes; tests that exercise the
  // runner-full branch override per-call with mockResolvedValueOnce.
  const execute = vi.fn(async () => [{ count: '0' }]);
  return {
    db: { select, update, execute },
  };
});

vi.mock('../runners/select.js', () => ({
  selectRunnerForJob: vi.fn(),
  defaultRunnerCapabilities: vi.fn((_t: string, p?: Record<string, unknown>) => p ?? {}),
}));

vi.mock('../runners/registry.js', () => ({
  getRunnerAdapter: vi.fn(),
}));

vi.mock('../pipeline/resolve-step-runner.js', () => ({
  resolveRunnerChainForJob: vi.fn(() => []),
}));

vi.mock('./active-device.js', () => ({
  getActiveDeviceId: vi.fn(),
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async () => 'worker-id-1'),
    offWork: vi.fn(async () => {}),
    send: vi.fn(async () => 'msg-1'),
    schedule: vi.fn(async () => {}),
  },
}));

vi.mock('../ws/server.js', () => ({
  roomManager: {
    publish: vi.fn(() => 0),
  },
}));

// ISS-4 wired ensureAgentSessionForJob into the dispatch path. The real
// implementation hits the DB; stub it so dispatcher tests stay focused on
// the dispatch envelope. Returns a deterministic ID so callers can assert
// it ends up in the job.assigned data when relevant.
vi.mock('./agent-session-link.js', () => ({
  ensureAgentSessionForJob: vi.fn(async () => 'sess-test'),
}));

// ISS-186 — prompt-snapshot helper writes two rows per dispatch (prompt_blobs
// UPSERT + jobs UPDATE). Mock so dispatcher tests focus on the dispatch
// envelope; the helper itself is covered in prompt-snapshot.test.ts.
vi.mock('./prompt-snapshot.js', () => ({
  persistPromptSnapshot: vi.fn(async () => {}),
}));

// ISS-162 — L1/L2/L3/L4 are evaluated inline by the picker, not the dispatcher.
// Only runnerSupportsJobType is still consulted post-pick. ISS-198 removed the
// dispatcher's post-pick L4 call; the picker now refuses to surface a job
// when no fresh, capable runner has capacity.
vi.mock('./dispatch-gates.js', () => ({
  // ISS-115 — dispatcher checks runner/job-type cap match after picking a
  // runner. Default to true so unrelated tests stay focused on their own
  // envelope; the unsupported-type test overrides with mockReturnValueOnce.
  runnerSupportsJobType: vi.fn(() => true),
  // ISS-226 — pre-dispatch barrier in handleDispatch / handlePmDispatch.
  // Default to false (no non-terminal prior) so existing tests dispatch
  // unchanged; the ISS-226 regression test overrides per-call.
  hasNonTerminalPriorSession: vi.fn(async () => false),
}));

// ISS-198 — dispatcher emits a Sentry breadcrumb + histogram sample when
// selectRunnerForJob returns null. Stub the observability surface so the
// "no runner online" branch stays pure in tests.
vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: vi.fn() },
  isSentryEnabled: () => false,
}));
vi.mock('../observability/hold-metrics.js', () => ({
  recordRunnerDeathDetection: vi.fn(),
  recordHoldSet: vi.fn(),
  recordHoldAutoClear: vi.fn(),
}));

const { db } = await import('../db/client.js');
const { getActiveDeviceId } = await import('./active-device.js');
// ISS-198 — dispatcher no longer imports checkLayer4RunnerFull.
const { runnerSupportsJobType, hasNonTerminalPriorSession } = await import('./dispatch-gates.js');
const {
  handleDispatch,
  handlePmDispatch,
  registerDispatcher,
  registerPmDispatcher,
  unregisterDispatcher,
  unregisterPmDispatcher,
  isDispatcherRegistered,
  isPmDispatcherRegistered,
} = await import('./dispatcher.js');
const { boss } = await import('../queue/boss.js');
const { roomManager } = await import('../ws/server.js');
const { selectRunnerForJob } = await import('../runners/select.js');
const { getRunnerAdapter } = await import('../runners/registry.js');
const { persistPromptSnapshot } = await import('./prompt-snapshot.js');

type Row = Record<string, unknown>;

function mockSelectOnce(rows: Row[]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).select.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({ limit: async () => rows }),
    }),
  }));
}

function mockUpdateReturn(rows: Row[]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).update.mockImplementationOnce(() => ({
    set: () => ({
      where: () => ({ returning: async () => rows }),
    }),
  }));
}

describe('jobs/dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pin to the legacy device dispatch path. After commit 2020bda8 flipped
    // all v0.1.x alpha flags default-on, runtime now goes through
    // `dispatchViaRunner` → `selectRunnerForJob` → `db.execute(...)` which
    // these tests don't mock. The runner path has its own coverage in
    // `runners/select.test.ts`; this suite specifically asserts the legacy
    // device path remains correct, so disable runnerFramework explicitly.
    process.env.FEATURE_RUNNER_FRAMEWORK = 'false';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.FEATURE_RUNNER_FRAMEWORK;
  });

  it('skips when job is missing', async () => {
    mockSelectOnce([]);
    const result = await handleDispatch({ jobId: 'missing' });
    expect(result).toBe('skipped');
  });

  it('skips when job is not queued', async () => {
    mockSelectOnce([{ id: 'j1', status: 'dispatched', projectId: 'p1' }]);
    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    expect(getActiveDeviceId).not.toHaveBeenCalled();
  });

  it('leaves queued when no active device configured', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1' }]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('leaves queued when active device is offline', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1' }]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    mockSelectOnce([{ id: 'd1', status: 'offline' }]);
    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('leaves queued when active device row is missing', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1' }]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d-missing');
    mockSelectOnce([]);
    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
  });

  // Exhaustive `toEqual` (not `objectContaining`) so omitting any field of the
  // job.assigned envelope fails the test. Subset matchers let the ISS-279
  // `issueId`-omission regression (fixed in 511c627d) slip through. See ISS-285.
  it('transitions job to dispatched when device is online and publishes job.assigned with full envelope', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T00:00:00.000Z'));
    try {
      mockSelectOnce([
        {
          id: 'j1',
          status: 'queued',
          projectId: 'p1',
          issueId: 'i1',
          type: 'plan',
          payload: { foo: 'bar' },
        },
      ]);
      (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
      // ISS-34: dispatcher requires fresh `lastSeenAt` (within DISPATCH_LIVENESS_MS).
    mockSelectOnce([{ id: 'd1', status: 'online', lastSeenAt: new Date() }]);
      mockUpdateReturn([{ id: 'j1' }]);
      // After UPDATE, dispatchViaDevice calls loadRepoPath which selects from
      // projects to feed ensureAgentSessionForJob. Mock the row so the chain
      // doesn't fall through to the unmocked .from() and crash.
      mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

      const result = await handleDispatch({ jobId: 'j1' });
      expect(result).toBe('dispatched');
      // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
      expect((db as any).update).toHaveBeenCalledTimes(1);
      // biome-ignore lint/suspicious/noExplicitAny: test-only mock
      expect((roomManager as any).publish).toHaveBeenCalledWith('device:d1', {
        event: 'job.assigned',
        data: {
          jobId: 'j1',
          projectId: 'p1',
          issueId: 'i1',
          type: 'plan',
          payload: { foo: 'bar' },
          promptString: null,
          // P1.1: pipeline preamble is always emitted; loadProjectBranches
          // swallows mock failures so the static rules + tools ship anyway.
          systemPrompt: expect.any(String),
          dispatchedAt: '2026-04-27T00:00:00.000Z',
          agentSessionId: 'sess-test',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression guard for ISS-279: issueId must be a sibling of `payload`
  // inside `data`, not nested inside `payload`. Device-runner code keys off
  // `data.issueId` to scope status updates back to the originating issue.
  it('event includes issueId at top level of data (not nested in payload)', async () => {
    mockSelectOnce([
      {
        id: 'j2',
        status: 'queued',
        projectId: 'p1',
        issueId: 'iss-abc',
        type: 'code',
        payload: { instructions: 'do thing' },
      },
    ]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    // ISS-34: dispatcher requires fresh `lastSeenAt` (within DISPATCH_LIVENESS_MS).
    mockSelectOnce([{ id: 'd1', status: 'online', lastSeenAt: new Date() }]);
    mockUpdateReturn([{ id: 'j2' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    await handleDispatch({ jobId: 'j2' });

    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    const call = (roomManager as any).publish.mock.calls[0];
    expect(call).toBeDefined();
    const envelope = call[1];
    expect(envelope.data.issueId).toBe('iss-abc');
    expect(envelope.data.payload).not.toHaveProperty('issueId');
  });

  it('skips when racing UPDATE returns zero rows and does NOT publish', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1', type: 'plan', payload: {} }]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    // ISS-34: dispatcher requires fresh `lastSeenAt` (within DISPATCH_LIVENESS_MS).
    mockSelectOnce([{ id: 'd1', status: 'online', lastSeenAt: new Date() }]);
    mockUpdateReturn([]);

    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((roomManager as any).publish).not.toHaveBeenCalled();
  });

  it('register/unregister is idempotent and toggles state', async () => {
    await registerDispatcher();
    await registerDispatcher();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((boss as any).work).toHaveBeenCalledTimes(1);
    expect(isDispatcherRegistered()).toBe(true);

    await unregisterDispatcher();
    await unregisterDispatcher();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((boss as any).offWork).toHaveBeenCalledTimes(1);
    expect(isDispatcherRegistered()).toBe(false);
  });

  // ISS-186 — prompt-snapshot is persisted after the `dispatched` flip and
  // before roomManager.publish so a snapshot lands on the same row even if
  // a follow-on consumer (web Inspector) reads quickly after dispatch.
  it('persists prompt snapshot after dispatched flip and before publish', async () => {
    mockSelectOnce([
      {
        id: 'j-snap',
        status: 'queued',
        projectId: 'p1',
        issueId: 'i1',
        type: 'plan',
        payload: { promptString: 'user-prompt-body' },
        modelTier: 'sonnet',
      },
    ]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    mockSelectOnce([{ id: 'd1', status: 'online', lastSeenAt: new Date() }]);
    mockUpdateReturn([{ id: 'j-snap' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    await handleDispatch({ jobId: 'j-snap' });

    expect(persistPromptSnapshot).toHaveBeenCalledTimes(1);
    const args = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args).toMatchObject({
      jobId: 'j-snap',
      userPrompt: 'user-prompt-body',
      model: 'sonnet',
    });
    expect(typeof args.systemPrompt).toBe('string');
    expect(args.systemPrompt.length).toBeGreaterThan(0);
    expect(Array.isArray(args.blocks)).toBe(true);

    // Ordering: snapshot fires before roomManager.publish.
    const snapInvocation = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    const publishInvocation = (roomManager as any).publish.mock.invocationCallOrder[0];
    expect(snapInvocation).toBeLessThan(publishInvocation);
  });

  // ISS-226 — race repro: when stage A's agent_session is still 'running'
  // at the moment stage B is dispatched, the dispatcher must leave B
  // queued (skipped) instead of dispatching against a missing prior
  // session. Once A flips terminal, the next tick's picker re-picks B and
  // dispatch succeeds. Without this barrier, `findPriorSessionInGroup`
  // returns null and the sessionGroup CLI resume silently regresses.
  it('ISS-226: leaves queued when a prior agent_session is still non-terminal for the same issue', async () => {
    mockSelectOnce([
      {
        id: 'j-plan',
        status: 'queued',
        projectId: 'p1',
        issueId: 'iss-201',
        type: 'plan',
        agentSessionId: null,
        payload: { sessionGroup: 'planning', stageStatus: 'confirmed' },
      },
    ]);
    (hasNonTerminalPriorSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const result = await handleDispatch({ jobId: 'j-plan' });
    expect(result).toBe('skipped');
    expect(hasNonTerminalPriorSession).toHaveBeenCalledWith('iss-201', null);
    // Job must remain queued — no dispatch flip, no runner selection,
    // no job.assigned broadcast.
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).not.toHaveBeenCalled();
    expect(selectRunnerForJob).not.toHaveBeenCalled();
    expect(getActiveDeviceId).not.toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((roomManager as any).publish).not.toHaveBeenCalled();
  });

  it('ISS-226: dispatches normally once the prior session is terminal', async () => {
    mockSelectOnce([
      {
        id: 'j-plan',
        status: 'queued',
        projectId: 'p1',
        issueId: 'iss-201',
        type: 'plan',
        agentSessionId: null,
        payload: { sessionGroup: 'planning' },
      },
    ]);
    // Default mock (returns false) means the barrier passes; explicit here
    // for clarity against the previous test.
    (hasNonTerminalPriorSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    mockSelectOnce([{ id: 'd1', status: 'online', lastSeenAt: new Date() }]);
    mockUpdateReturn([{ id: 'j-plan' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handleDispatch({ jobId: 'j-plan' });
    expect(result).toBe('dispatched');
    expect(hasNonTerminalPriorSession).toHaveBeenCalledWith('iss-201', null);
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((roomManager as any).publish).toHaveBeenCalledTimes(1);
  });

  it('ISS-226: skips the barrier when job has no issueId (project-scoped jobs)', async () => {
    mockSelectOnce([
      {
        id: 'j-orphan',
        status: 'queued',
        projectId: 'p1',
        issueId: null,
        type: 'plan',
        payload: {},
      },
    ]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    mockSelectOnce([{ id: 'd1', status: 'online', lastSeenAt: new Date() }]);
    mockUpdateReturn([{ id: 'j-orphan' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handleDispatch({ jobId: 'j-orphan' });
    expect(result).toBe('dispatched');
    // Barrier short-circuited — no DB query for the prior-session check.
    expect(hasNonTerminalPriorSession).not.toHaveBeenCalled();
  });

  it('defaults model to "default" when modelTier is not set', async () => {
    mockSelectOnce([
      {
        id: 'j-default-model',
        status: 'queued',
        projectId: 'p1',
        issueId: 'i1',
        type: 'plan',
        payload: {},
        modelTier: null,
      },
    ]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    mockSelectOnce([{ id: 'd1', status: 'online', lastSeenAt: new Date() }]);
    mockUpdateReturn([{ id: 'j-default-model' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    await handleDispatch({ jobId: 'j-default-model' });

    const args = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.model).toBe('default');
    expect(args.userPrompt).toBe('');
  });
});

describe('jobs/dispatcher PM path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // PM path always runs through dispatchViaRunner regardless of the
    // runnerFramework flag, but flip it on for parity with prod and to keep
    // future readers from second-guessing.
    process.env.FEATURE_RUNNER_FRAMEWORK = 'true';
  });

  afterEach(() => {
    vi.clearAllMocks();
    // biome-ignore lint/performance/noDelete: matches existing teardown pattern at top of file
    delete process.env.FEATURE_RUNNER_FRAMEWORK;
  });

  it('dispatches a pm job to a pm-capable runner with forced {pm:true} filter', async () => {
    mockSelectOnce([
      { id: 'pm-1', status: 'queued', projectId: 'p1', type: 'pm', payload: {}, issueId: null },
    ]);
    (selectRunnerForJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'r1',
      type: 'claude-code',
      deviceId: 'd1',
    });
    const dispatchSpy = vi.fn(async () => ({ status: 'dispatched' }));
    (getRunnerAdapter as ReturnType<typeof vi.fn>).mockReturnValueOnce({ dispatch: dispatchSpy });
    mockUpdateReturn([{ id: 'pm-1' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handlePmDispatch({ jobId: 'pm-1' });
    expect(result).toBe('dispatched');
    expect(selectRunnerForJob).toHaveBeenCalledWith({
      projectId: 'p1',
      requiredCapabilities: { pm: true },
      fallbackChain: ['claude-code'],
      pinDeviceId: null,
    });

    // ISS-186 — snapshot must persist on runner path too, before adapter.dispatch.
    expect(persistPromptSnapshot).toHaveBeenCalledTimes(1);
    const snapArgs = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(snapArgs).toMatchObject({ jobId: 'pm-1', userPrompt: '' });
    expect(typeof snapArgs.systemPrompt).toBe('string');
    expect(Array.isArray(snapArgs.blocks)).toBe(true);
    const snapInvocation = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const adapterInvocation = dispatchSpy.mock.invocationCallOrder[0];
    expect(snapInvocation).toBeLessThan(adapterInvocation);
  });

  it('forces the {pm:true} filter even when payload tries to override it', async () => {
    mockSelectOnce([
      {
        id: 'pm-2',
        status: 'queued',
        projectId: 'p1',
        type: 'pm',
        // Producer attempts to clear the filter — handlePmDispatch must ignore.
        payload: { requiredCapabilities: {} },
        issueId: null,
      },
    ]);
    (selectRunnerForJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const result = await handlePmDispatch({ jobId: 'pm-2' });
    expect(result).toBe('skipped');
    expect(selectRunnerForJob).toHaveBeenCalledWith({
      projectId: 'p1',
      requiredCapabilities: { pm: true },
      fallbackChain: ['claude-code'],
      pinDeviceId: null,
    });
  });

  it('skips when no pm-capable runner is online (job stays queued)', async () => {
    mockSelectOnce([
      { id: 'pm-3', status: 'queued', projectId: 'p1', type: 'pm', payload: {}, issueId: null },
    ]);
    (selectRunnerForJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const result = await handlePmDispatch({ jobId: 'pm-3' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('refuses non-pm jobs that land on the pm queue (defence-in-depth)', async () => {
    mockSelectOnce([
      { id: 'j1', status: 'queued', projectId: 'p1', type: 'plan', payload: {}, issueId: null },
    ]);
    const result = await handlePmDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    expect(selectRunnerForJob).not.toHaveBeenCalled();
  });

  it('skips when pm job is missing or non-queued', async () => {
    mockSelectOnce([]);
    expect(await handlePmDispatch({ jobId: 'missing' })).toBe('skipped');

    mockSelectOnce([{ id: 'pm-x', status: 'dispatched', projectId: 'p1', type: 'pm' }]);
    expect(await handlePmDispatch({ jobId: 'pm-x' })).toBe('skipped');
  });

  it('ISS-115: fails the job permanently when the runner does not support its job type', async () => {
    mockSelectOnce([
      { id: 'rel-1', status: 'queued', projectId: 'p1', type: 'release', payload: {}, issueId: 'iss-1' },
    ]);
    (selectRunnerForJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'r1',
      type: 'claude-code',
      deviceId: 'd1',
    });
    (getRunnerAdapter as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      dispatch: vi.fn(),
    });
    // Mock fallback chain lookup (the project agentConfig select).
    mockSelectOnce([{ agentConfig: null }]);
    (runnerSupportsJobType as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    // Permanent-failure UPDATE returning value isn't read; just give it
    // something to consume so the mock chain doesn't crash.
    mockUpdateReturn([]);

    const result = await handleDispatch({ jobId: 'rel-1' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((db as any).update).toHaveBeenCalledTimes(1);
    // Adapter must NOT be invoked when the cap fails.
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((roomManager as any).publish).not.toHaveBeenCalled();
  });

  it('ISS-115: forwards payload.promptString as a top-level field on job.assigned (legacy device path)', async () => {
    process.env.FEATURE_RUNNER_FRAMEWORK = 'false';
    mockSelectOnce([
      {
        id: 'j-prompt',
        status: 'queued',
        projectId: 'p1',
        issueId: 'iss-1',
        type: 'plan',
        payload: { promptString: '/forge-plan iss-1', skillName: 'forge-plan' },
      },
    ]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    mockSelectOnce([{ id: 'd1', status: 'online', lastSeenAt: new Date() }]);
    mockUpdateReturn([{ id: 'j-prompt' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handleDispatch({ jobId: 'j-prompt' });
    expect(result).toBe('dispatched');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((roomManager as any).publish).toHaveBeenCalledWith(
      'device:d1',
      expect.objectContaining({
        event: 'job.assigned',
        data: expect.objectContaining({
          jobId: 'j-prompt',
          promptString: '/forge-plan iss-1',
        }),
      }),
    );
  });

  it('register/unregister is idempotent and creates the PM_QUEUE_NAME queue', async () => {
    await registerPmDispatcher();
    await registerPmDispatcher();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    const createQueueCalls = (boss as any).createQueue.mock.calls.map((c: unknown[]) => c[0]);
    expect(createQueueCalls).toContain('forge.pm-jobs');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((boss as any).work).toHaveBeenCalledTimes(1);
    expect(isPmDispatcherRegistered()).toBe(true);

    await unregisterPmDispatcher();
    await unregisterPmDispatcher();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((boss as any).offWork).toHaveBeenCalledTimes(1);
    expect(isPmDispatcherRegistered()).toBe(false);
  });
});
