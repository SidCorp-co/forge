import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The dispatch import graph reaches env-validating modules (embeddings via
// the prompt/preamble chain); stub env so collection doesn't require real
// DATABASE_URL/JWT_SECRET in unit-test runs.
vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));

vi.mock('../db/client.js', () => {
  // Base impl returns an empty-row chain so an unmatched select (e.g. the
  // project-default mcpServers lookup `resolveProjectDefaultMcpServers`, which
  // runs LAST in the dispatch after all `mockSelectOnce` queues are drained)
  // resolves to `[]` instead of throwing on `undefined.from`. Per-test
  // `mockSelectOnce` (mockImplementationOnce) still takes precedence in order.
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ limit: async () => [] as Record<string, unknown>[] }) }),
  }));
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
  // Device circuit breaker (feat-device-circuit-breaker) — default to "no
  // tripped devices" so the dispatch path is unaffected unless a test opts in.
  getTrippedDeviceIds: vi.fn(async () => [] as string[]),
}));

vi.mock('../runners/registry.js', () => ({
  getRunnerAdapter: vi.fn(),
}));

vi.mock('../pipeline/resolve-step-runner.js', () => ({
  resolveRunnerChainForJob: vi.fn(() => []),
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
  // ISS-228 — SSOT pre-dispatch barrier in handleDispatch / handlePmDispatch.
  // Default to `{ ok: true }` so existing tests dispatch unchanged; the
  // ISS-226 / ISS-228 regression tests override per-call with a failing
  // barrier to assert the skip path.
  assertDispatchable: vi.fn(async () => ({ ok: true })),
  // Per-project concurrency cap (default 1) — feeds the load-aware selector.
  resolveProjectCap: vi.fn(async () => 1),
  // Atomic per-runner claim that replaced the inline dispatch UPDATE. Default
  // to a successful claim so the envelope/adapter assertions stay focused; the
  // race/over-cap behaviour is covered in dispatch-loadbalance-e2e (real PG).
  claimRunnerSlot: vi.fn(async () => 'claimed'),
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
  // ISS-228 — per-reason counter incremented when assertDispatchable
  // leaves a job queued. Test mock so the unit tests don't need a
  // metrics-state reset between cases.
  recordDispatchBarrierSkip: vi.fn(),
  // ISS-580 — counter for fresh-instead-of-resume decisions.
  recordResumeBoundFresh: vi.fn(),
}));

// ISS-336 / ISS-581 — mock all three integration resolvers so dispatcher tests
// don't stand up project_integrations + vault. Default: return override unchanged
// (mirrors "no active integration" / "sentinel absent" path). Per-test overrides
// use mockImplementationOnce.
vi.mock('../integrations/postman/resolver.js', () => ({
  applyPostmanMcpServers: vi.fn(
    async (_projectId: string, current: Record<string, unknown> | null) => current,
  ),
}));
vi.mock('../integrations/epodsystem/resolver.js', () => ({
  applyEpodsystemMcpServers: vi.fn(
    async (_projectId: string, current: Record<string, unknown> | null) => current,
  ),
}));
vi.mock('../integrations/sentry/resolver.js', () => ({
  applySentryMcpServers: vi.fn(
    async (_projectId: string, current: Record<string, unknown> | null) => current,
  ),
}));

// ISS-580 — mock session-resume helpers so bound-check tests can directly
// control what each function returns without wiring up the full DB chain.
// Defaults: no prior session (→ resume skipped), conservative defaults bounds,
// and 0 estimated tokens. Per-test overrides use mockResolvedValueOnce.
vi.mock('./session-resume.js', () => ({
  findPriorSessionInGroup: vi.fn(async () => null),
  loadResumeBounds: vi.fn(async () => ({ maxResumeTokens: 150_000, maxResumeReopenCycles: 3 })),
  estimateGroupContextTokens: vi.fn(async () => 0),
}));

const { db } = await import('../db/client.js');
// ISS-198 — dispatcher no longer imports checkLayer4RunnerFull.
const { runnerSupportsJobType, assertDispatchable } = await import('./dispatch-gates.js');
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
const { claimRunnerSlot } = await import('./dispatch-gates.js');
const { getRunnerAdapter } = await import('../runners/registry.js');
const { persistPromptSnapshot } = await import('./prompt-snapshot.js');
const { applyPostmanMcpServers } = await import('../integrations/postman/resolver.js');
const { applyEpodsystemMcpServers } = await import('../integrations/epodsystem/resolver.js');
const { applySentryMcpServers } = await import('../integrations/sentry/resolver.js');
const { findPriorSessionInGroup, loadResumeBounds, estimateGroupContextTokens } = await import('./session-resume.js');
const { recordResumeBoundFresh } = await import('../observability/hold-metrics.js');

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

// ISS-267 — the legacy device dispatch path (`dispatchViaDevice` /
// `getActiveDeviceId`) was removed; `handleDispatch` now always routes
// through `dispatchViaRunner` → `selectRunnerForJob` → adapter.dispatch.
// These tests mock the runner selection + adapter so they assert the
// dispatch envelope without standing up the runner registry. Runner
// selection itself is covered in `runners/select.test.ts`.
function mockRunnerDispatch(opts: { deviceId?: string } = {}): ReturnType<typeof vi.fn> {
  (selectRunnerForJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    id: 'r1',
    type: 'claude-code',
    deviceId: opts.deviceId ?? 'd1',
  });
  const dispatchSpy = vi.fn(async (..._args: unknown[]) => ({ status: 'dispatched' }));
  (getRunnerAdapter as ReturnType<typeof vi.fn>).mockReturnValueOnce({ dispatch: dispatchSpy });
  return dispatchSpy;
}

describe('jobs/dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks only clears call history — mockImplementationOnce queues
    // persist. The dispatch flip moved into the mocked claimRunnerSlot, so the
    // happy-path tests' mockUpdateReturn(...) is never consumed and would leak
    // a non-empty UPDATE into a later test's applyKernelTransition. Reset the
    // update mock's one-shot queue each test (it has no base impl → undefined).
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    (db as any).update.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
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
    expect(selectRunnerForJob).not.toHaveBeenCalled();
  });

  it('leaves queued when no runner is online', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1', type: 'plan', payload: {} }]);
    // dispatchViaRunner reads the project agentConfig for the fallback chain.
    mockSelectOnce([{ agentConfig: null }]);
    (selectRunnerForJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('dispatches to the runner adapter with the full job envelope', async () => {
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
      mockSelectOnce([{ agentConfig: null }]);
      const dispatchSpy = mockRunnerDispatch();
      mockUpdateReturn([{ id: 'j1' }]);
      // After UPDATE, dispatchViaRunner calls loadRepoPath which selects from
      // projects to feed ensureAgentSessionForJob. Mock the row so the chain
      // doesn't fall through to the unmocked .from() and crash.
      mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

      const result = await handleDispatch({ jobId: 'j1' });
      expect(result).toBe('dispatched');
      // The dispatched-flip now happens inside the atomic claimRunnerSlot
      // (per-runner CAS gate), not an inline db.update in handleDispatch.
      expect(claimRunnerSlot).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const arg = dispatchSpy.mock.calls[0]?.[0] as {
        job: Record<string, unknown>;
        runner: Record<string, unknown>;
      };
      // issueId must be a sibling of `payload` on the job envelope, not nested
      // inside `payload` — ISS-279 regression guard (claude-code adapter keys
      // off `data.issueId`).
      expect(arg.job).toMatchObject({
        id: 'j1',
        projectId: 'p1',
        issueId: 'i1',
        type: 'plan',
        payload: { foo: 'bar' },
        promptString: null,
        agentSessionId: 'sess-test',
        dispatchedAt: new Date('2026-04-27T00:00:00.000Z'),
      });
      expect(typeof arg.job.systemPrompt).toBe('string');
      expect((arg.job.payload as Record<string, unknown>).issueId).toBeUndefined();
      expect(arg.runner).toMatchObject({ id: 'r1', type: 'claude-code', deviceId: 'd1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips when the runner-slot claim is lost (CAS) and does NOT dispatch to the adapter', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1', type: 'plan', payload: {} }]);
    mockSelectOnce([{ agentConfig: null }]);
    const dispatchSpy = mockRunnerDispatch();
    // claimRunnerSlot loses the queued→dispatched CAS (another dispatcher won).
    (claimRunnerSlot as ReturnType<typeof vi.fn>).mockResolvedValueOnce('lost');

    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    expect(dispatchSpy).not.toHaveBeenCalled();
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
  // before adapter.dispatch so a snapshot lands on the same row even if a
  // follow-on consumer (web Inspector) reads quickly after dispatch.
  it('persists prompt snapshot after dispatched flip and before adapter.dispatch', async () => {
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
    mockSelectOnce([{ agentConfig: null }]);
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-snap' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    await handleDispatch({ jobId: 'j-snap' });

    expect(persistPromptSnapshot).toHaveBeenCalledTimes(1);
    const args = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(args).toMatchObject({
      jobId: 'j-snap',
      userPrompt: 'user-prompt-body',
      model: 'sonnet',
    });
    expect(typeof args.systemPrompt).toBe('string');
    expect(args.systemPrompt.length).toBeGreaterThan(0);
    expect(Array.isArray(args.blocks)).toBe(true);

    // Ordering: snapshot fires before adapter.dispatch.
    const snapInvocation = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const adapterInvocation = dispatchSpy.mock.invocationCallOrder[0];
    expect(snapInvocation).toBeLessThan(adapterInvocation ?? Number.NEGATIVE_INFINITY);
  });

  // ISS-228 — SSOT barrier replaces ISS-226's narrow L1-only check. When
  // ANY gate fails (manual_hold, blocked_by, project_cap, runner_full,
  // retry_cooldown, pipeline_run_running, issue_busy), the dispatcher must
  // leave the job queued — no dispatch flip, no runner selection, no
  // adapter dispatch.
  it('ISS-228: leaves queued when assertDispatchable returns a failing barrier (issue_busy)', async () => {
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
    (assertDispatchable as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: 'issue_busy',
    });

    const result = await handleDispatch({ jobId: 'j-plan' });
    expect(result).toBe('skipped');
    expect(assertDispatchable).toHaveBeenCalledWith('j-plan');
    // Job must remain queued — no dispatch flip, no runner selection.
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).not.toHaveBeenCalled();
    expect(selectRunnerForJob).not.toHaveBeenCalled();
  });

  it('ISS-228: leaves queued with reason=project_cap when L3 fails (pg-boss burst protection)', async () => {
    mockSelectOnce([
      {
        id: 'j-cap',
        status: 'queued',
        projectId: 'p1',
        issueId: 'iss-other',
        type: 'code',
        agentSessionId: null,
        payload: {},
      },
    ]);
    (assertDispatchable as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: 'project_cap',
    });

    const result = await handleDispatch({ jobId: 'j-cap' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('ISS-228: dispatches normally when assertDispatchable returns ok:true', async () => {
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
    // Default mock ({ ok: true }) — barrier passes.
    mockSelectOnce([{ agentConfig: null }]);
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-plan' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handleDispatch({ jobId: 'j-plan' });
    expect(result).toBe('dispatched');
    expect(assertDispatchable).toHaveBeenCalledWith('j-plan');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('ISS-228: barrier runs even for project-scoped jobs (issueId=null)', async () => {
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
    mockSelectOnce([{ agentConfig: null }]);
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-orphan' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handleDispatch({ jobId: 'j-orphan' });
    expect(result).toBe('dispatched');
    // SSOT barrier always runs — its SQL handles the null issue_id case
    // correctly (project_cap clause uses `j.issue_id IS NOT NULL`).
    expect(assertDispatchable).toHaveBeenCalledWith('j-orphan');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
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
    mockSelectOnce([{ agentConfig: null }]);
    mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-default-model' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    await handleDispatch({ jobId: 'j-default-model' });

    const args = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(args.model).toBe('default');
    expect(args.userPrompt).toBe('');
  });

  // ISS-535 — reopen-driven escalation. A `fix` job on a reopened issue
  // (reopenCount >= 1) bumps the default `reopen` tier (sonnet) up the ladder.
  // Select order for a non-pm fix job (stageStatus set): (1) job lookup,
  // (2) checkMonthlyBudget→resolveStageOverrides loadStageMap, (3) fallback
  // chain, (4) preDispatch resolveStageOverrides loadStageMap, (5) loadRepoPath,
  // (6) escalation issues.reopenCount lookup. The mcp-resolver selects after
  // fall through to the base empty-row mock.
  it('ISS-535: escalates a fix job up the tier ladder when reopenCount >= 1', async () => {
    mockSelectOnce([
      {
        id: 'j-fix',
        status: 'queued',
        projectId: 'p1',
        issueId: 'iss-r',
        type: 'fix',
        payload: { stageStatus: 'reopen' },
      },
    ]);
    mockSelectOnce([{ agentConfig: null }]); // budget-check loadStageMap → no budget → allow
    mockSelectOnce([{ agentConfig: null }]); // fallback chain
    mockSelectOnce([{ agentConfig: null }]); // preDispatch loadStageMap → default 'sonnet'
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-fix' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]); // loadRepoPath
    mockSelectOnce([{ reopenCount: 1 }]); // escalation lookup

    const result = await handleDispatch({ jobId: 'j-fix' });
    expect(result).toBe('dispatched');
    const arg = dispatchSpy.mock.calls[0]?.[0] as { job: { payload: Record<string, unknown> } };
    expect(arg.job.payload.model).toBe('opus'); // sonnet +1 step → opus
  });

  it('ISS-535: does NOT escalate a fix job when reopenCount is 0', async () => {
    mockSelectOnce([
      {
        id: 'j-fix0',
        status: 'queued',
        projectId: 'p1',
        issueId: 'iss-r0',
        type: 'fix',
        payload: { stageStatus: 'reopen' },
      },
    ]);
    mockSelectOnce([{ agentConfig: null }]); // budget-check loadStageMap
    mockSelectOnce([{ agentConfig: null }]); // fallback chain
    mockSelectOnce([{ agentConfig: null }]); // preDispatch loadStageMap → default 'sonnet'
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-fix0' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]); // loadRepoPath
    mockSelectOnce([{ reopenCount: 0 }]); // escalation lookup → no bump

    const result = await handleDispatch({ jobId: 'j-fix0' });
    expect(result).toBe('dispatched');
    const arg = dispatchSpy.mock.calls[0]?.[0] as { job: { payload: Record<string, unknown> } };
    expect(arg.job.payload.model).toBe('sonnet'); // base reopen tier, unescalated
  });

  it('ISS-535: a non-fix/review job is never escalated (no reopenCount lookup)', async () => {
    mockSelectOnce([
      {
        id: 'j-code',
        status: 'queued',
        projectId: 'p1',
        issueId: 'iss-c',
        type: 'code',
        payload: { stageStatus: 'approved' },
      },
    ]);
    mockSelectOnce([{ agentConfig: null }]); // budget-check loadStageMap
    mockSelectOnce([{ agentConfig: null }]); // fallback chain
    mockSelectOnce([{ agentConfig: null }]); // preDispatch loadStageMap → default 'sonnet'
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-code' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]); // loadRepoPath
    // No escalation select is queued — the code path must not perform one.

    const result = await handleDispatch({ jobId: 'j-code' });
    expect(result).toBe('dispatched');
    const arg = dispatchSpy.mock.calls[0]?.[0] as { job: { payload: Record<string, unknown> } };
    expect(arg.job.payload.model).toBe('sonnet'); // approved → code → balanced, no escalation
  });

  // ISS-336 review blocker regression — the dispatcher must shallow-copy the
  // resolved overrides before layering the project's Postman MCP entry. The old
  // code mutated `preDispatchOverrides` in place; on the no-override path
  // resolveStageOverrides returns a shared module-level EMPTY singleton by
  // reference, so the mutation wrote one project's Postman API key onto that
  // singleton — leaking it into the NEXT EMPTY-path dispatch for a DIFFERENT
  // project (cross-tenant) and defeating the active=false/deleted drop
  // guarantee. Dispatch a project WITH Postman, then one WITHOUT, and assert the
  // second envelope carries no postman entry.
  // ISS-580 — Resume bound check tests.
  //
  // The bound check runs when priorClaudeSessionId is set AND
  // preDispatchOverrides.sessionGroup is non-null. To get a non-null
  // sessionGroup from resolveStageOverrides, the job must have stageStatus
  // in its payload AND the project must have a matching states entry with
  // sessionGroup configured.
  //
  // DB select order for these tests (type='code', stageStatus='approved'):
  //   1. job lookup
  //   2. checkMonthlyBudget → resolveStageOverrides → loadStageMap
  //   3. dispatchViaRunner fallback chain
  //   4. dispatchViaRunner → resolveStageOverrides → loadStageMap (preDispatch)
  //   5. [new] reopenCount lookup (issues table)
  //   6. loadRepoPath

  const agentConfigWithGroup = {
    pipelineConfig: {
      sessionGroups: { build: ['approved'] },
      states: { approved: { sessionGroup: 'build' } },
    },
  };

  it('ISS-580: resumes normally when both bounds are under threshold (regression guard)', async () => {
    mockSelectOnce([{
      id: 'j-resume',
      status: 'queued',
      projectId: 'p1',
      issueId: 'iss-1',
      type: 'code',
      payload: { stageStatus: 'approved' },
    }]);
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]); // budget-check loadStageMap
    mockSelectOnce([{ agentConfig: null }]);                  // fallback chain
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]); // preDispatch loadStageMap
    // Prior session exists (below bound).
    (findPriorSessionInGroup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      claudeSessionId: 'cli-old',
      deviceId: 'd-old',
    });
    // Bounds: 150k tokens / 3 cycles; estimated: 50k; reopenCount: 0.
    (estimateGroupContextTokens as ReturnType<typeof vi.fn>).mockResolvedValueOnce(50_000);
    mockSelectOnce([{ reopenCount: 0 }]); // reopenCount lookup
    const dispatchSpy = mockRunnerDispatch({ deviceId: 'd-old' });
    mockUpdateReturn([{ id: 'j-resume' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]); // loadRepoPath

    const result = await handleDispatch({ jobId: 'j-resume' });
    expect(result).toBe('dispatched');
    expect(recordResumeBoundFresh).not.toHaveBeenCalled();
    // resume proceeds — adapter is called with the prior session's device
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('ISS-580: drops resume when estimated tokens exceed maxResumeTokens', async () => {
    mockSelectOnce([{
      id: 'j-over-tokens',
      status: 'queued',
      projectId: 'p1',
      issueId: 'iss-2',
      type: 'code',
      payload: { stageStatus: 'approved' },
    }]);
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]); // budget-check loadStageMap
    mockSelectOnce([{ agentConfig: null }]);                  // fallback chain
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]); // preDispatch loadStageMap
    (findPriorSessionInGroup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      claudeSessionId: 'cli-huge',
      deviceId: 'd-huge',
    });
    // Over token bound (363K > 150K default).
    (estimateGroupContextTokens as ReturnType<typeof vi.fn>).mockResolvedValueOnce(363_000);
    mockSelectOnce([{ reopenCount: 0 }]); // reopenCount lookup
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-over-tokens' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]); // loadRepoPath

    const result = await handleDispatch({ jobId: 'j-over-tokens' });
    expect(result).toBe('dispatched');
    // Counter incremented with reason 'tokens'.
    expect(recordResumeBoundFresh).toHaveBeenCalledWith('tokens');
    // resume dropped — job dispatched to a freely-selected device (not pinned).
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('ISS-580: drops resume when reopenCount exceeds maxResumeReopenCycles', async () => {
    mockSelectOnce([{
      id: 'j-over-cycles',
      status: 'queued',
      projectId: 'p1',
      issueId: 'iss-3',
      type: 'code',
      payload: { stageStatus: 'approved' },
    }]);
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]); // budget-check loadStageMap
    mockSelectOnce([{ agentConfig: null }]);                  // fallback chain
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]); // preDispatch loadStageMap
    (findPriorSessionInGroup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      claudeSessionId: 'cli-stale',
      deviceId: 'd-stale',
    });
    // Under token bound but over cycle bound (4 > 3 default).
    (estimateGroupContextTokens as ReturnType<typeof vi.fn>).mockResolvedValueOnce(10_000);
    mockSelectOnce([{ reopenCount: 4 }]); // reopenCount lookup
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-over-cycles' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]); // loadRepoPath

    const result = await handleDispatch({ jobId: 'j-over-cycles' });
    expect(result).toBe('dispatched');
    expect(recordResumeBoundFresh).toHaveBeenCalledWith('reopen_cycles');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('ISS-580: gate disabled (maxResumeTokens=0) skips token check', async () => {
    mockSelectOnce([{
      id: 'j-gate-off',
      status: 'queued',
      projectId: 'p1',
      issueId: 'iss-4',
      type: 'code',
      payload: { stageStatus: 'approved' },
    }]);
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]); // budget-check loadStageMap
    mockSelectOnce([{ agentConfig: null }]);                  // fallback chain
    mockSelectOnce([{ agentConfig: agentConfigWithGroup }]); // preDispatch loadStageMap
    (findPriorSessionInGroup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      claudeSessionId: 'cli-ok',
      deviceId: 'd-ok',
    });
    // Gate disabled for tokens; huge count, still resumes.
    (loadResumeBounds as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      maxResumeTokens: 0,
      maxResumeReopenCycles: 3,
    });
    (estimateGroupContextTokens as ReturnType<typeof vi.fn>).mockResolvedValueOnce(999_999);
    mockSelectOnce([{ reopenCount: 0 }]); // reopenCount lookup
    const dispatchSpy = mockRunnerDispatch({ deviceId: 'd-ok' });
    mockUpdateReturn([{ id: 'j-gate-off' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]); // loadRepoPath

    const result = await handleDispatch({ jobId: 'j-gate-off' });
    expect(result).toBe('dispatched');
    expect(recordResumeBoundFresh).not.toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('ISS-580: no sessionGroup → bound check is a no-op (no prior session lookup)', async () => {
    // Job without stageStatus → resolveStageOverrides returns EMPTY (sessionGroup=null).
    mockSelectOnce([{
      id: 'j-no-group',
      status: 'queued',
      projectId: 'p1',
      issueId: 'iss-5',
      type: 'code',
      payload: { foo: 'bar' },
    }]);
    mockSelectOnce([{ agentConfig: null }]); // fallback chain (no stageStatus → no budget-check loadStageMap)
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-no-group' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]); // loadRepoPath

    const result = await handleDispatch({ jobId: 'j-no-group' });
    expect(result).toBe('dispatched');
    expect(findPriorSessionInGroup).not.toHaveBeenCalled();
    expect(recordResumeBoundFresh).not.toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  // ISS-581 — browser dedup: when both playwright and chrome-devtools-mcp are
  // present in the merged map, only chrome-devtools-mcp should survive.
  it('ISS-581: drops playwright when both browser servers are present (dedup)', async () => {
    // Stage has both browser servers declared.
    (applyPostmanMcpServers as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_p: string, c: Record<string, unknown> | null) => c,
    );
    (applyEpodsystemMcpServers as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_p: string, c: Record<string, unknown> | null) => c,
    );
    (applySentryMcpServers as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_p: string, c: Record<string, unknown> | null) => c,
    );
    // agentConfig with a stage that declares both browser servers
    const agentConfigBothBrowsers = {
      pipelineConfig: {
        states: {
          approved: {
            mcpServers: {
              playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
              'chrome-devtools-mcp': { type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@latest'], env: {} },
            },
          },
        },
      },
    };
    mockSelectOnce([{
      id: 'j-dedup',
      status: 'queued',
      projectId: 'p1',
      issueId: 'i1',
      type: 'code',
      payload: { stageStatus: 'approved' },
    }]);
    mockSelectOnce([{ agentConfig: agentConfigBothBrowsers }]); // budget-check loadStageMap
    mockSelectOnce([{ agentConfig: null }]); // fallback chain
    mockSelectOnce([{ agentConfig: agentConfigBothBrowsers }]); // preDispatch loadStageMap
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-dedup' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handleDispatch({ jobId: 'j-dedup' });
    expect(result).toBe('dispatched');
    const arg = dispatchSpy.mock.calls[0]?.[0] as { job: { payload: Record<string, unknown> } };
    const mcp = arg.job.payload.mcpServersOverride as Record<string, unknown> | undefined;
    expect(mcp?.['chrome-devtools-mcp']).toBeDefined();
    expect(mcp?.playwright).toBeUndefined();
  });

  // ISS-581 — AC#1: integration server NOT injected when stage has no sentinel.
  it('ISS-581: active sentry integration is NOT injected when stage has no sentry sentinel', async () => {
    // Override: applySentryMcpServers behaves as opt-in (sentinel absent → no inject).
    // Default mock already passes current through unchanged, which is the correct behavior.
    mockSelectOnce([{
      id: 'j-no-sentry',
      status: 'queued',
      projectId: 'p1',
      issueId: 'i1',
      type: 'test',
      payload: { stageStatus: 'testing' },
    }]);
    mockSelectOnce([{ agentConfig: null }]); // budget-check
    mockSelectOnce([{ agentConfig: null }]); // fallback chain
    mockSelectOnce([{ agentConfig: null }]); // preDispatch loadStageMap
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-no-sentry' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handleDispatch({ jobId: 'j-no-sentry' });
    expect(result).toBe('dispatched');
    const arg = dispatchSpy.mock.calls[0]?.[0] as { job: { payload: Record<string, unknown> } };
    const mcp = arg.job.payload.mcpServersOverride as Record<string, unknown> | undefined;
    // With no mcpServers declared and no sentinel, mcp should be null/undefined
    expect(mcp?.sentry).toBeUndefined();
  });

  // ISS-581 — AC#2: no leftover `true` sentinel ever reaches the runner.
  it('ISS-581: sentinel sweep removes leftover `true` for integration names', async () => {
    // Simulate: stage has sentry: true but sentry integration is absent.
    // applySentryMcpServers (real) would strip the sentinel; since we mock it here,
    // simulate the sentinel being present after the mock chain and verify the
    // sentinel sweep in dispatcher cleans it up.
    (applySentryMcpServers as ReturnType<typeof vi.fn>).mockImplementationOnce(
      // Simulate resolver returning current unchanged (sentinel present but no integration)
      // which would leave `sentry: true` in the map — sweep should remove it.
      async (_p: string, c: Record<string, unknown> | null) => c,
    );
    const agentConfigWithSentinel = {
      pipelineConfig: {
        states: {
          testing: { mcpServers: { sentry: true } },
        },
      },
    };
    mockSelectOnce([{
      id: 'j-sweep',
      status: 'queued',
      projectId: 'p1',
      issueId: 'i1',
      type: 'test',
      payload: { stageStatus: 'testing' },
    }]);
    mockSelectOnce([{ agentConfig: agentConfigWithSentinel }]); // budget-check
    mockSelectOnce([{ agentConfig: null }]); // fallback chain
    mockSelectOnce([{ agentConfig: agentConfigWithSentinel }]); // preDispatch loadStageMap
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-sweep' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handleDispatch({ jobId: 'j-sweep' });
    expect(result).toBe('dispatched');
    const arg = dispatchSpy.mock.calls[0]?.[0] as { job: { payload: Record<string, unknown> } };
    const mcp = arg.job.payload.mcpServersOverride as Record<string, unknown> | undefined;
    // The sentinel `true` must NOT reach the runner
    expect(mcp?.sentry).not.toBe(true);
  });

  it('ISS-336: does not leak the Postman MCP entry into a later dispatch for another project', async () => {
    // Dispatch 1 — project p1 has an active Postman integration.
    (applyPostmanMcpServers as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_projectId: string, current: Record<string, unknown> | null) => ({
        ...(current ?? {}),
        postman: { type: 'http', url: 'https://mcp.postman.com/minimal', enabled: true },
      }),
    );
    mockSelectOnce([{ id: 'j-pm-on', status: 'queued', projectId: 'p1', type: 'plan', payload: {} }]);
    mockSelectOnce([{ agentConfig: null }]);
    const spyWith = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-pm-on' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    expect(await handleDispatch({ jobId: 'j-pm-on' })).toBe('dispatched');

    // Dispatch 2 — project p2 has NO Postman integration. The default resolver
    // mock returns the override unchanged (i.e. resolvePostmanMcpEntry → null).
    mockSelectOnce([{ id: 'j-pm-off', status: 'queued', projectId: 'p2', type: 'plan', payload: {} }]);
    mockSelectOnce([{ agentConfig: null }]);
    const spyWithout = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-pm-off' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    expect(await handleDispatch({ jobId: 'j-pm-off' })).toBe('dispatched');

    const payloadWith = (spyWith.mock.calls[0]?.[0] as { job: { payload: Record<string, unknown> } })
      .job.payload;
    const payloadWithout = (
      spyWithout.mock.calls[0]?.[0] as { job: { payload: Record<string, unknown> } }
    ).job.payload;
    const mcpWith = payloadWith.mcpServersOverride as Record<string, unknown> | undefined;
    const mcpWithout = payloadWithout.mcpServersOverride as Record<string, unknown> | undefined;

    // p1 carries the injected entry…
    expect(mcpWith?.postman).toBeDefined();
    // …and p2 must NOT inherit it via a polluted singleton.
    expect(mcpWithout?.postman).toBeUndefined();
  });
});

describe('jobs/dispatcher PM path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks only clears call history — mockImplementationOnce queues
    // persist. The dispatch flip moved into the mocked claimRunnerSlot, so the
    // happy-path tests' mockUpdateReturn(...) is never consumed and would leak
    // a non-empty UPDATE into a later test's applyKernelTransition. Reset the
    // update mock's one-shot queue each test (it has no base impl → undefined).
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    (db as any).update.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
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
    const dispatchSpy = vi.fn(async (..._args: unknown[]) => ({ status: 'dispatched' }));
    (getRunnerAdapter as ReturnType<typeof vi.fn>).mockReturnValueOnce({ dispatch: dispatchSpy });
    mockUpdateReturn([{ id: 'pm-1' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handlePmDispatch({ jobId: 'pm-1' });
    expect(result).toBe('dispatched');
    expect(selectRunnerForJob).toHaveBeenCalledWith({
      projectId: 'p1',
      requiredCapabilities: { pm: true },
      pinDeviceId: null,
      excludeDeviceIds: [],
      skipPrimary: false,
      projectCap: 1,
    });

    // ISS-186 — snapshot must persist on runner path too, before adapter.dispatch.
    expect(persistPromptSnapshot).toHaveBeenCalledTimes(1);
    const snapArgs = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(snapArgs).toMatchObject({ jobId: 'pm-1', userPrompt: '' });
    expect(typeof snapArgs.systemPrompt).toBe('string');
    expect(Array.isArray(snapArgs.blocks)).toBe(true);
    const snapInvocation = (persistPromptSnapshot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const adapterInvocation = dispatchSpy.mock.invocationCallOrder[0];
    expect(snapInvocation).toBeLessThan(adapterInvocation ?? Number.NEGATIVE_INFINITY);
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
      pinDeviceId: null,
      excludeDeviceIds: [],
      skipPrimary: false,
      projectCap: 1,
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

  it('ISS-115: forwards payload.promptString on the runner job envelope', async () => {
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
    // fallback-chain lookup (project agentConfig).
    mockSelectOnce([{ agentConfig: null }]);
    const dispatchSpy = mockRunnerDispatch();
    mockUpdateReturn([{ id: 'j-prompt' }]);
    mockSelectOnce([{ repoPath: '/repo', agentConfig: null }]);

    const result = await handleDispatch({ jobId: 'j-prompt' });
    expect(result).toBe('dispatched');
    const arg = dispatchSpy.mock.calls[0]?.[0] as { job: { id: string; promptString: unknown } };
    expect(arg.job.id).toBe('j-prompt');
    expect(arg.job.promptString).toBe('/forge-plan iss-1');
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
