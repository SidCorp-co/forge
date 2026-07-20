import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unified thenable mock: each select() terminal consumes one `nextSelect` row.
// Default to empty array so unmocked SELECT calls (eg. loadIssueSnapshot when
// the test only cares about the dispatch path) behave like a row-not-found
// query instead of returning undefined and TypeError-destructuring.
const nextSelect = vi.fn(() => [] as unknown[]);
function makeWhereChain() {
  let consumed = false;
  const resolver = async () => {
    if (consumed) return [];
    consumed = true;
    return nextSelect();
  };
  const chain: Record<string, unknown> = {};
  const thenKey = 'then';
  chain[thenKey] = (onFulfilled: (v: unknown) => unknown) => resolver().then(onFulfilled);
  chain.limit = (_n: number) => resolver();
  return chain;
}

const insertReturning = vi.fn();
const dbInsert = vi.fn(() => ({
  values: () => ({ returning: insertReturning }),
}));

// ISS-196 — `considerEnqueue` wraps the find+insert critical section in
// `db.transaction(tx => ...)` after taking `pg_advisory_xact_lock`. The tx
// callback receives a tx with `execute` (for the lock) and `select`/`insert`
// proxied to the same mocks (so `findActiveJob` and `insertAndEnqueueJob`
// continue to see the same plumbing).
const txExecute = vi.fn(async () => undefined);
vi.mock('../db/client.js', () => {
  const dbStub = {
    select: () => ({ from: () => ({ where: () => makeWhereChain() }) }),
    insert: dbInsert,
    execute: txExecute,
  };
  return {
    db: {
      ...dbStub,
      transaction: vi.fn(async (cb: (tx: typeof dbStub) => unknown) => cb(dbStub)),
    },
  };
});

const enqueueMock = vi.fn(async () => {});
vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: (...a: unknown[]) => enqueueMock(...(a as [])),
}));

// ISS-110 — auto-skip helper invokes applyStatusTransition once per hop. Stub
// it so unit tests can assert hop count + targets without modeling the full
// status update path (DB UPDATE + WS broadcast + run timeline sync). The 4th
// arg captures the options bag so we can assert `{ skip: true }` flows
// through (without it, `canTransition` rejects `developed → testing` and the
// chain hangs — see review blocker #1).
const applyTransitionMock = vi.fn<
  (issue: unknown, toStatus: string, device: unknown, options?: { skip?: boolean }) => Promise<void>
>(async () => undefined);
vi.mock('../issues/apply-transition.js', () => ({
  applyStatusTransition: (...a: unknown[]) =>
    applyTransitionMock(a[0], a[1] as string, a[2], a[3] as { skip?: boolean } | undefined),
}));

// ISS-110 — verify Sentry breadcrumb emission per skip hop.
const sentryAddBreadcrumb =
  vi.fn<(crumb: { category: string; data: Record<string, unknown> }) => void>();
vi.mock('../observability/sentry.js', () => ({
  Sentry: {
    addBreadcrumb: (...a: unknown[]) =>
      sentryAddBreadcrumb(a[0] as { category: string; data: Record<string, unknown> }),
  },
  isSentryEnabled: () => true,
}));

// ISS-101 — orchestrator now opens a pipeline_run before inserting jobs.
// Short-circuit the helper so the test's single-insert mock plumbing
// (which only models the `jobs` insert) still matches.
vi.mock('./runs.js', () => ({
  openIssueRun: vi.fn(async () => ({ id: 'mock-run-id', startedAt: new Date() })),
  openOneShotRun: vi.fn(async () => ({ id: 'mock-run-id' })),
  closeRun: vi.fn(async () => undefined),
  closeRunIfOneShot: vi.fn(async () => undefined),
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStep: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

// ISS-238 — guard helpers hit DB paths the orchestrator unit test doesn't
// model (db.update, db.select + project owner join, comments insert). Stub
// them so the test asserts orchestration intent (helper called with the
// right args) without re-deriving the helper's DB shape.
const pauseMissingSkillMock = vi.fn(async (..._args: unknown[]) => ({
  paused: true,
  alreadyPaused: false,
}));
const postMissingSkillCommentMock = vi.fn(async () => undefined);
vi.mock('./missing-skill-guard.js', () => ({
  PAUSE_REASON_PREFIX: 'missing_skill:',
  buildMissingSkillReason: (stage: string) => `missing_skill:${stage}`,
  buildMissingSkillCommentBody: (stage: string) => `body:${stage}`,
  pausePipelineRunMissingSkill: (...a: unknown[]) => pauseMissingSkillMock(...(a as [])),
  postMissingSkillComment: (...a: unknown[]) => postMissingSkillCommentMock(...(a as [])),
}));

const queryPreventiveMock = vi.fn(async () => []);
vi.mock('./ci-fix-pattern-query.js', () => ({
  queryPreventivePatterns: (...a: unknown[]) => queryPreventiveMock(...(a as [])),
}));

// ISS-635 Change B — empty-reopen guard posts a comment via its own DB
// insert. Stub it so orchestrator unit tests assert orchestration intent
// (guard fired / device + status used) without modeling the comment insert.
const postEmptyReopenCommentMock = vi.fn(async () => undefined);
vi.mock('./empty-reopen-guard.js', () => ({
  buildEmptyReopenCommentBody: () => 'body',
  postEmptyReopenComment: (...a: unknown[]) => postEmptyReopenCommentMock(...(a as [])),
}));

// ISS-108 — orchestrator resolves skillName from the DB via
// createProjectSkillResolver. Stubbing the module keeps the orchestrator unit
// test pure (no skill_registrations rows needed) and lets each case control
// whether a registration exists for the target stage.
const resolverResolve = vi.fn();
// ISS-239 — autoSkipDisabledStages calls resolver.stages() to build the
// `hasSkill` predicate. Default to a set containing every stage so existing
// ISS-110 tests (which don't set up stage registrations) keep their original
// expectations — the skip predicate then degrades to the original
// `enabled === false` behaviour. Individual ISS-239 tests override this.
const resolverStagesMock = vi.fn<() => Promise<ReadonlySet<string>>>(
  async () =>
    new Set<string>([
      'open',
      'needs_info',
      'confirmed',
      'clarified',
      'approved',
      'developed',
      'testing',
      'tested',
      'deploying',
      'reopen',
      'released',
    ]),
);
const createProjectSkillResolverMock = vi.fn((_projectId: string) => ({
  resolve: resolverResolve,
  stages: resolverStagesMock,
}));
vi.mock('./skill-mapping.js', async () => {
  const actual = await vi.importActual<typeof import('./skill-mapping.js')>('./skill-mapping.js');
  return {
    ...actual,
    createProjectSkillResolver: (projectId: string) => createProjectSkillResolverMock(projectId),
  };
});

// ISS-239 — stub skip-chain logging so unit tests don't model the
// pipeline_runs UPDATE / comments INSERT side effects.
const appendSkipChainEntryMock = vi.fn<
  (runId: string, entry: { from: string; to: string; reason: string; at: string }) => Promise<void>
>(async () => undefined);
const postSkipChainCappedCommentMock = vi.fn<
  (args: {
    projectId: string;
    issueId: string;
    from: string;
    visited: string[];
  }) => Promise<void>
>(async () => undefined);
// Default-on handoff prefetch (proposal Y) — orchestrator now calls this
// before buildJobPromptString. Stub to no-op so unit tests stay focused on
// orchestrator scheduling logic instead of DB query plumbing for handoffs.
vi.mock('./handoff-prefetch.js', () => ({
  fetchHandoffPromptInputs: async () => ({ priorHandoffs: null, handoffScope: null }),
}));

vi.mock('./skip-chain-log.js', () => ({
  appendSkipChainEntry: (
    runId: string,
    entry: { from: string; to: string; reason: string; at: string },
  ) => appendSkipChainEntryMock(runId, entry),
  postSkipChainCappedComment: (args: {
    projectId: string;
    issueId: string;
    from: string;
    visited: string[];
  }) => postSkipChainCappedCommentMock(args),
  buildSkipChainCappedCommentBody: () => 'body',
}));

const { HooksBus } = await import('./hooks.js');
const { registerPipelineOrchestrator } = await import('./orchestrator.js');

type TransitionPayload = {
  issueId: string;
  projectId: string;
  actor: { type: 'user' | 'device'; id: string };
  from: string;
  to: string;
  reopenCount: number;
  reason?: string;
};

type CreatedPayload = {
  issueId: string;
  projectId: string;
  actor: { type: 'user' | 'device'; id: string };
  status: string;
  snapshot: Record<string, unknown>;
};

function makeBus() {
  const bus = new HooksBus();
  registerPipelineOrchestrator(bus);
  return bus;
}

function transition(overrides: Partial<TransitionPayload> = {}): TransitionPayload {
  return {
    issueId: 'iss-1',
    projectId: 'proj-1',
    actor: { type: 'user', id: 'u-1' },
    from: 'open',
    to: 'confirmed',
    reopenCount: 0,
    ...overrides,
  };
}

function issueCreated(overrides: Partial<CreatedPayload> = {}): CreatedPayload {
  return {
    issueId: 'iss-1',
    projectId: 'proj-1',
    actor: { type: 'user', id: 'u-1' },
    status: 'open',
    snapshot: {},
    ...overrides,
  };
}

function cfgResolved(cfg: unknown) {
  nextSelect.mockResolvedValueOnce([
    { agentConfig: { pipelineConfig: cfg }, createdBy: 'u-owner' },
  ]);
}

function skillRegistered(skillName: string, type: string, toggle: string) {
  resolverResolve.mockResolvedValueOnce({ skillName, type, toggle });
}

function noSkillRegistered() {
  resolverResolve.mockResolvedValueOnce(null);
}

// ISS-635 Change A — considerEnqueue re-reads the live issue row
// (loadIssueForSkip) before dispatching. Queue the row a passing test
// expects to find (status matching the dispatch target keeps the guard a
// no-op); mismatched/missing rows are what the race-guard tests assert on.
function liveIssue(
  status: string,
  overrides: Partial<{ id: string; projectId: string; reopenCount: number }> = {},
) {
  nextSelect.mockResolvedValueOnce([
    { id: 'iss-1', projectId: 'proj-1', status, reopenCount: 0, ...overrides },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  nextSelect.mockReset();
  // mockReset wipes the default impl; restore it so unmocked SELECT calls
  // (eg. loadIssueSnapshot when the test only cares about the dispatch path)
  // return [] instead of undefined and TypeError-destructuring.
  nextSelect.mockImplementation(() => [] as unknown[]);
  resolverResolve.mockReset();
  resolverStagesMock.mockReset();
  // Default: hasSkill returns true for every stage so the ISS-110 tests
  // continue to rely solely on `states[stage].enabled === false` as the
  // skip trigger.
  resolverStagesMock.mockResolvedValue(
    new Set<string>([
      'open',
      'needs_info',
      'confirmed',
      'clarified',
      'approved',
      'developed',
      'testing',
      'tested',
      'deploying',
      'reopen',
      'released',
    ]),
  );
  pauseMissingSkillMock.mockReset();
  pauseMissingSkillMock.mockResolvedValue({ paused: true, alreadyPaused: false });
  postMissingSkillCommentMock.mockReset();
  postEmptyReopenCommentMock.mockReset();
  appendSkipChainEntryMock.mockReset();
  appendSkipChainEntryMock.mockResolvedValue(undefined);
  postSkipChainCappedCommentMock.mockReset();
  postSkipChainCappedCommentMock.mockResolvedValue(undefined);
});

describe('pipeline/orchestrator', () => {
  it('enqueues a plan job on confirmed→clarified when autoPlan is true', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    skillRegistered('forge-plan', 'plan', 'autoPlan');
    liveIssue('clarified');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'new-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'confirmed', to: 'clarified' }) as never);

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'new-job' }));
  });

  it('uses the registered skill name in the inserted job payload', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    skillRegistered('custom-planner', 'plan', 'autoPlan');
    liveIssue('clarified');
    nextSelect.mockResolvedValueOnce([]);
    insertReturning.mockResolvedValueOnce([{ id: 'job-x' }]);

    const valuesSpy = vi.fn((..._args: unknown[]) => ({ returning: insertReturning }));
    dbInsert.mockImplementationOnce(() => ({ values: valuesSpy }));

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'confirmed', to: 'clarified' }) as never);

    expect(valuesSpy).toHaveBeenCalledTimes(1);
    const calls = valuesSpy.mock.calls as unknown as Array<[{ payload: { skillName: string } }]>;
    expect(calls[0]?.[0].payload.skillName).toBe('custom-planner');
  });

  it('skips when pipelineConfig.enabled is false', async () => {
    cfgResolved({ enabled: false, autoPlan: true });

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('skips when the per-step toggle is false', async () => {
    cfgResolved({ enabled: true, autoPlan: false });

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'confirmed', to: 'clarified' }) as never);

    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('skips when states[status].enabled is false', async () => {
    cfgResolved({
      enabled: true,
      autoPlan: true,
      states: { confirmed: { enabled: false, mode: 'auto' } },
    });

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  it('skips when states[status].mode is manual', async () => {
    cfgResolved({
      enabled: true,
      autoPlan: true,
      states: { confirmed: { enabled: true, mode: 'manual' } },
    });

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  it('refuses + pauses the run when no skill is registered for the auto stage (ISS-238)', async () => {
    cfgResolved({ enabled: true, autoClarify: true });
    liveIssue('confirmed');
    noSkillRegistered();

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    // No job enqueued — the guard intercepts before insertAndEnqueueJob.
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    // Run paused with the right reason; operator-facing comment posted once.
    expect(pauseMissingSkillMock).toHaveBeenCalledTimes(1);
    expect(pauseMissingSkillMock.mock.calls[0]?.[0]).toMatchObject({
      runId: 'mock-run-id',
      projectId: 'proj-1',
      issueId: 'iss-1',
      stage: 'confirmed',
    });
    expect(postMissingSkillCommentMock).toHaveBeenCalledTimes(1);
  });

  it('does not post a duplicate comment when the run is already paused with the same reason (ISS-238)', async () => {
    cfgResolved({ enabled: true, autoClarify: true });
    liveIssue('confirmed');
    noSkillRegistered();
    pauseMissingSkillMock.mockResolvedValueOnce({ paused: false, alreadyPaused: true });

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(pauseMissingSkillMock).toHaveBeenCalledTimes(1);
    expect(postMissingSkillCommentMock).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('skips human-gated target statuses (waiting)', async () => {
    const bus = makeBus();
    // biome-ignore lint/suspicious/noExplicitAny: test-only cast
    await bus.emit('transition', transition({ to: 'waiting' }) as any);
    expect(dbInsert).not.toHaveBeenCalled();
    expect(nextSelect).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  it('skips needs_info→open (guard against answer-loop)', async () => {
    const bus = makeBus();
    // biome-ignore lint/suspicious/noExplicitAny: test-only cast
    await bus.emit('transition', transition({ from: 'needs_info', to: 'open' }) as any);
    expect(dbInsert).not.toHaveBeenCalled();
    expect(nextSelect).not.toHaveBeenCalled();
  });

  // ISS-411 — operator-hold guard: an issue leaving `on_hold` via a NON-user
  // actor (the aborted agent's termination-protocol advance) must NOT
  // re-dispatch. Only a human Resume (actor.type==='user') re-engages.
  it('does NOT enqueue on a non-user advance out of on_hold (agent termination override)', async () => {
    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({
        from: 'on_hold',
        to: 'developed',
        actor: { type: 'device', id: 'dev-1' },
      }) as never,
    );
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    // Short-circuits before any cfg/skill resolution.
    expect(nextSelect).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  it('DOES enqueue on a human Resume out of on_hold (user actor)', async () => {
    cfgResolved({ enabled: true, autoReview: true });
    skillRegistered('forge-review', 'review', 'autoReview');
    liveIssue('developed');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'resume-job' }]);

    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({ from: 'on_hold', to: 'developed', actor: { type: 'user', id: 'u-1' } }) as never,
    );

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'resume-job' }));
  });

  // ISS-596 — operator_unblock escape hatch: a non-user actor carrying
  // reason:'operator_unblock' must re-engage the pipeline (MCP unblock).
  it('ISS-596: DOES enqueue on non-user on_hold advance with reason:operator_unblock', async () => {
    cfgResolved({ enabled: true, autoTriage: true });
    skillRegistered('forge-triage', 'triage', 'autoTriage');
    liveIssue('open');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'unblock-job' }]);

    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({
        from: 'on_hold',
        to: 'open',
        actor: { type: 'device', id: 'dev-1' },
        reason: 'operator_unblock',
      }) as never,
    );

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'unblock-job' }));
  });

  it('ISS-596: does NOT enqueue on non-user on_hold advance without reason (hard-stop intact)', async () => {
    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({
        from: 'on_hold',
        to: 'open',
        actor: { type: 'device', id: 'dev-1' },
        // no reason field → stale agent advance
      }) as never,
    );
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(nextSelect).not.toHaveBeenCalled();
  });

  // ISS-702 — defense-in-depth mirror of the ISS-411 on_hold guard for
  // `waiting`: a non-user advance out of `waiting` (e.g. a stale zombie job's
  // finalize-failure clobbering the park) must NOT re-dispatch.
  it('ISS-702: does NOT enqueue on a non-user advance out of waiting (stale finalize-failure write)', async () => {
    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({
        from: 'waiting',
        to: 'approved',
        actor: { type: 'device', id: 'dev-1' },
      }) as never,
    );
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(nextSelect).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  it('ISS-702: DOES enqueue on a human Resume out of waiting (user actor)', async () => {
    cfgResolved({ enabled: true, autoCode: true });
    skillRegistered('forge-code', 'code', 'autoCode');
    liveIssue('approved');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'resume-job' }]);

    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({ from: 'waiting', to: 'approved', actor: { type: 'user', id: 'u-1' } }) as never,
    );

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'resume-job' }));
  });

  it('ISS-702: DOES enqueue on non-user waiting advance with reason:operator_unblock', async () => {
    cfgResolved({ enabled: true, autoCode: true });
    skillRegistered('forge-code', 'code', 'autoCode');
    liveIssue('approved');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'unblock-job' }]);

    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({
        from: 'waiting',
        to: 'approved',
        actor: { type: 'device', id: 'dev-1' },
        reason: 'operator_unblock',
      }) as never,
    );

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'unblock-job' }));
  });

  it('dedupes when an active job of the same type already exists', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    skillRegistered('forge-plan', 'plan', 'autoPlan');
    liveIssue('clarified');
    nextSelect.mockResolvedValueOnce([{ id: 'existing-job' }]); // findActiveJob

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'confirmed', to: 'clarified' }) as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('treats a unique-index violation on insert as a dedupe skip', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    skillRegistered('forge-plan', 'plan', 'autoPlan');
    liveIssue('clarified');
    nextSelect.mockResolvedValueOnce([]);
    insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'confirmed', to: 'clarified' }) as never);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('falls back to project owner for createdBy on device-triggered transitions', async () => {
    cfgResolved({ enabled: true, autoReview: true });
    skillRegistered('forge-review', 'review', 'autoReview');
    liveIssue('developed');
    nextSelect.mockResolvedValueOnce([]);
    insertReturning.mockResolvedValueOnce([{ id: 'job-x' }]);

    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({
        from: 'deploying',
        to: 'developed',
        actor: { type: 'device', id: 'dev-1' },
      }) as never,
    );

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-x' }));
  });

  it('enqueues a clarify job on open→confirmed when autoClarify is true (clarify-on-happy-path)', async () => {
    cfgResolved({ enabled: true, autoClarify: true });
    skillRegistered('forge-clarify', 'clarify', 'autoClarify');
    liveIssue('confirmed');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'clarify-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'clarify-job' }));
  });

  it('does not enqueue on open→confirmed when autoClarify is false', async () => {
    cfgResolved({ enabled: true, autoClarify: false });

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  it('complexity-skip: xs issue at confirmed advances to clarified without a clarify job', async () => {
    cfgResolved({
      enabled: true,
      autoClarify: true,
      states: { confirmed: { skipComplexities: ['xs', 's'] } },
    });
    // autoSkipByComplexity issue fetch
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'confirmed', reopenCount: 0, complexity: 'xs' },
    ]);

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(applyTransitionMock).toHaveBeenCalledTimes(1);
    expect(applyTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'iss-1', status: 'confirmed' }),
      'clarified',
      expect.anything(),
      { skip: true },
    );
    expect(appendSkipChainEntryMock).toHaveBeenCalledWith(
      'mock-run-id',
      expect.objectContaining({ from: 'confirmed', to: 'clarified', reason: 'complexity_skip' }),
    );
    // No clarify job for the stage we just left.
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('complexity-skip: m issue at confirmed still dispatches clarify', async () => {
    cfgResolved({
      enabled: true,
      autoClarify: true,
      states: { confirmed: { skipComplexities: ['xs', 's'] } },
    });
    skillRegistered('forge-clarify', 'clarify', 'autoClarify');
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'confirmed', reopenCount: 0, complexity: 'm' },
    ]); // autoSkipByComplexity issue fetch — m not in skip list
    liveIssue('confirmed');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'clarify-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'clarify-job' }));
  });

  it('complexity-skip: unsized issue (complexity null) is never skipped', async () => {
    cfgResolved({
      enabled: true,
      autoClarify: true,
      states: { confirmed: { skipComplexities: ['xs', 's'] } },
    });
    skillRegistered('forge-clarify', 'clarify', 'autoClarify');
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'confirmed', reopenCount: 0, complexity: null },
    ]);
    liveIssue('confirmed');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'clarify-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'clarify-job' }));
  });

  it('does not enqueue on →needs_info (human-gated bounce state)', async () => {
    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'confirmed', to: 'needs_info' }) as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(nextSelect).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  it('enqueues a triage job on issueCreated when autoTriage is true', async () => {
    cfgResolved({ enabled: true, autoTriage: true });
    skillRegistered('forge-triage', 'triage', 'autoTriage');
    liveIssue('open');
    nextSelect.mockResolvedValueOnce([]);
    insertReturning.mockResolvedValueOnce([{ id: 'triage-job' }]);

    const bus = makeBus();
    await bus.emit('issueCreated', issueCreated() as never);

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'triage-job' }));
  });

  it('does not enqueue on issueCreated when autoTriage is false', async () => {
    cfgResolved({ enabled: true, autoTriage: false });

    const bus = makeBus();
    await bus.emit('issueCreated', issueCreated() as never);

    expect(dbInsert).not.toHaveBeenCalled();
  });

  // ISS-130 — when forge-plan creates a decomposition child at `status:
  // 'on_hold'`, the orchestrator's issueCreated subscriber must NOT enqueue
  // any job. `on_hold` has no STATUS_TO_JOB_TYPE entry so considerEnqueue
  // short-circuits before loading cfg or hitting findActiveJob.
  it('does not enqueue when issueCreated payload.status is on_hold', async () => {
    const bus = makeBus();
    await bus.emit('issueCreated', issueCreated({ status: 'on_hold' }) as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(nextSelect).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  // ISS-236 — drafts are AI-generated proposals waiting for human review.
  // The orchestrator must not auto-enqueue any pipeline job for them; the
  // user has to explicitly promote draft → open first.
  it('does not enqueue when issueCreated payload.status is draft', async () => {
    const bus = makeBus();
    await bus.emit('issueCreated', issueCreated({ status: 'draft' }) as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(nextSelect).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  // ISS-635 Change A — the transition hook fires from the outbox's DB
  // snapshot (payload.to), which can be stale by the time considerEnqueue
  // runs (e.g. a review self-correction reopen→testing racing the
  // reopen→fix dispatch). Mirrors the autoSkipDisabledStages race guard.
  it('ISS-635: stale reopen dispatch race — live status no longer reopen, no fix enqueued', async () => {
    cfgResolved({ enabled: true, autoFix: true });
    liveIssue('testing'); // race: another writer already advanced past reopen

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'testing', to: 'reopen' }) as never);

    expect(resolverResolve).not.toHaveBeenCalled();
    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(postEmptyReopenCommentMock).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  // ISS-635 Change B — a reopen with zero prior code/fix job has nothing for
  // forge-fix to patch. Route to needs_info instead of dispatching an empty
  // fix job.
  it('ISS-635: reopen with no prior code/fix job routes to needs_info instead of dispatching fix', async () => {
    cfgResolved({ enabled: true, autoFix: true });
    liveIssue('reopen');
    nextSelect.mockResolvedValueOnce([]); // hasPriorImplementationJob → none

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'testing', to: 'reopen' }) as never);

    // Guard intercepts before the skill resolver / job insert.
    expect(resolverResolve).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(applyTransitionMock).toHaveBeenCalledTimes(1);
    expect(applyTransitionMock.mock.calls[0]?.[0]).toMatchObject({ id: 'iss-1', status: 'reopen' });
    expect(applyTransitionMock.mock.calls[0]?.[1]).toBe('needs_info');
    expect(postEmptyReopenCommentMock).toHaveBeenCalledTimes(1);
    expect(postEmptyReopenCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'iss-1' }),
    );
  });

  it('ISS-635: reopen WITH a prior code job still dispatches fix (regression)', async () => {
    cfgResolved({ enabled: true, autoFix: true });
    liveIssue('reopen');
    nextSelect.mockResolvedValueOnce([{ id: 'prior-code-job' }]); // hasPriorImplementationJob → found
    skillRegistered('forge-fix', 'fix', 'autoFix');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'fix-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'testing', to: 'reopen' }) as never);

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(postEmptyReopenCommentMock).not.toHaveBeenCalled();
    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'fix-job' }));
  });
});

describe('pipeline/orchestrator soft-skip (ISS-110)', () => {
  it('auto-transitions past a single disabled stage and skips the would-be job', async () => {
    cfgResolved({
      enabled: true,
      autoReview: true,
      states: { developed: { enabled: false } },
    });
    // autoSkipDisabledStages loads the current issue row.
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'developed', reopenCount: 0 },
    ]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'in_progress', to: 'developed' }) as never);

    expect(applyTransitionMock).toHaveBeenCalledTimes(1);
    expect(applyTransitionMock.mock.calls[0]?.[1]).toBe('testing');
    // Review blocker #1: the soft-skip path must pass `{ skip: true }` so the
    // state-machine bypass kicks in. Without this, applyStatusTransition
    // throws ILLEGAL_TRANSITION for developed → testing and the issue is
    // stranded forever at `developed`.
    expect(applyTransitionMock.mock.calls[0]?.[3]).toEqual({ skip: true });
    // ISS-239 — two breadcrumbs per hop: the compat `pipeline_run.status_changed`
    // and the new `pipeline_run.auto_skip` carrying the typed reason.
    const categories = sentryAddBreadcrumb.mock.calls.map((c) => c[0]?.category);
    expect(categories).toContain('pipeline_run.status_changed');
    expect(categories).toContain('pipeline_run.auto_skip');
    const autoSkip = sentryAddBreadcrumb.mock.calls.find(
      (c) => c[0]?.category === 'pipeline_run.auto_skip',
    );
    expect(autoSkip?.[0]).toMatchObject({
      data: { reason: 'stage_disabled', fromStatus: 'developed', toStatus: 'testing' },
    });
    // ISS-239 — per-hop metadata writes for the skipChain.
    expect(appendSkipChainEntryMock).toHaveBeenCalledTimes(1);
    expect(appendSkipChainEntryMock.mock.calls[0]?.[1]).toMatchObject({
      from: 'developed',
      to: 'testing',
      reason: 'stage_disabled',
    });
    // considerEnqueue runs second; the disabled-stage guard short-circuits it.
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('walks a two-stage disabled chain one hop at a time (developed → testing → tested gate)', async () => {
    cfgResolved({
      enabled: true,
      states: {
        developed: { enabled: false },
        testing: { enabled: false },
        // `tested` is the manual release gate — the walk anchors here (never
        // auto-skips a manual stage), parking the issue for a human.
        tested: { mode: 'manual' },
      },
    });
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'developed', reopenCount: 0 },
    ]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'in_progress', to: 'developed' }) as never);

    // Per-hop emission gives downstream subscribers (and Sentry) the full
    // status history — AC #4 requires a breadcrumb per skip transition.
    expect(applyTransitionMock).toHaveBeenCalledTimes(2);
    expect(applyTransitionMock.mock.calls[0]?.[1]).toBe('testing');
    expect(applyTransitionMock.mock.calls[1]?.[1]).toBe('tested');
    // ISS-239 — two categories per hop, so 4 breadcrumbs total for a 2-hop chain.
    expect(sentryAddBreadcrumb).toHaveBeenCalledTimes(4);
    // ISS-239 — per-hop skipChain entries.
    expect(appendSkipChainEntryMock).toHaveBeenCalledTimes(2);
    expect(appendSkipChainEntryMock.mock.calls[0]?.[1]).toMatchObject({
      from: 'developed',
      to: 'testing',
      reason: 'stage_disabled',
    });
    expect(appendSkipChainEntryMock.mock.calls[1]?.[1]).toMatchObject({
      from: 'testing',
      to: 'tested',
      reason: 'stage_disabled',
    });
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('does not skip when the target stage is enabled', async () => {
    cfgResolved({
      enabled: true,
      autoReview: true,
      states: { developed: { enabled: true } },
    });
    // ISS-108 — considerEnqueue resolves the skillName via the resolver mock
    // before inserting. Without a registration, it logs+skips, so we have to
    // queue a skill here for the assertion to count an insert.
    skillRegistered('forge-review', 'review', 'autoReview');
    // No issue lookup in autoSkip (bails before that) — but considerEnqueue's
    // own live-status re-check (ISS-635 Change A) still fires before the
    // no-active-job select and the insert.
    liveIssue('developed');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'review-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'in_progress', to: 'developed' }) as never);

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(dbInsert).toHaveBeenCalledTimes(1);
  });

  it('bails when the issue row has already moved (race with another writer)', async () => {
    cfgResolved({
      enabled: true,
      states: { developed: { enabled: false } },
    });
    // Status mismatch — another writer advanced past `developed` already.
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'testing', reopenCount: 0 },
    ]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'in_progress', to: 'developed' }) as never);

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('considerEnqueue guard: refuses to insert a job for a disabled stage even when autoSkip is a no-op', async () => {
    // States says `confirmed` is disabled. autoSkip would try to skip — but
    // we simulate a failure by returning a stale issue row (status mismatch)
    // so autoSkip bails. The guard inside considerEnqueue must still prevent
    // the plan-job insert that would otherwise happen.
    cfgResolved({
      enabled: true,
      autoPlan: true,
      states: { confirmed: { enabled: false } },
    });
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'approved', reopenCount: 0 },
    ]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'open', to: 'confirmed' }) as never);

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
  });
});

describe('pipeline/orchestrator auto-skip missing skill (ISS-239)', () => {
  it('auto-skips past a stage with no registered skill even when states is undefined', async () => {
    cfgResolved({ enabled: true, autoTest: true });
    // Only `testing` has a registered skill — `developed` (review) does not.
    // (`deploying` was retired in 53fe4a4e; review now exits straight to testing,
    // so `developed` is the skill-less stage that skips to `testing`.)
    resolverStagesMock.mockResolvedValueOnce(new Set<string>(['testing']));
    // autoSkipDisabledStages reads the current issue row to confirm status.
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'developed', reopenCount: 0 },
    ]);
    // After the skip lands on `testing`, considerEnqueue resolves the test skill.
    skillRegistered('forge-test', 'test', 'autoTest');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'test-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'in_progress', to: 'developed' }) as never);

    expect(applyTransitionMock).toHaveBeenCalledTimes(1);
    expect(applyTransitionMock.mock.calls[0]?.[1]).toBe('testing');
    expect(applyTransitionMock.mock.calls[0]?.[3]).toEqual({ skip: true });
    const autoSkipCrumb = sentryAddBreadcrumb.mock.calls.find(
      (c) => c[0]?.category === 'pipeline_run.auto_skip',
    );
    expect(autoSkipCrumb?.[0]).toMatchObject({
      data: { reason: 'missing_skill', fromStatus: 'developed', toStatus: 'testing' },
    });
    expect(appendSkipChainEntryMock).toHaveBeenCalledTimes(1);
    expect(appendSkipChainEntryMock.mock.calls[0]?.[1]).toMatchObject({
      from: 'developed',
      to: 'testing',
      reason: 'missing_skill',
    });
    // ISS-238 pause guard MUST NOT fire — auto-skip intercepted before considerEnqueue
    // would have refused the missing-skill `developed` stage.
    expect(pauseMissingSkillMock).not.toHaveBeenCalled();
  });

  it('does not pause via ISS-238 guard when the landing stage has its own missing skill (cap path)', async () => {
    // No skills at all. autoSkip walks the chain to the first non-skippable
    // anchor (`closed`). For payload.to = 'tested' (the
    // gate), the chain is tested → released → closed. `closed` is
    // non-skippable → anchors there. No cap fires.
    cfgResolved({ enabled: true });
    resolverStagesMock.mockResolvedValueOnce(new Set<string>());
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'tested', reopenCount: 0 },
    ]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'testing', to: 'tested' }) as never);

    expect(applyTransitionMock).toHaveBeenCalledTimes(2);
    expect(applyTransitionMock.mock.calls.map((c) => c[1])).toEqual(['released', 'closed']);
    expect(appendSkipChainEntryMock).toHaveBeenCalledTimes(2);
    expect(postSkipChainCappedCommentMock).not.toHaveBeenCalled();
  });

  it('does not skip when payload.to has a registered skill (forge-test pickup)', async () => {
    cfgResolved({ enabled: true, autoTest: true });
    // testing has a skill — autoSkip should bail and considerEnqueue should
    // dispatch normally.
    resolverStagesMock.mockResolvedValueOnce(new Set<string>(['testing']));
    skillRegistered('forge-test', 'test', 'autoTest');
    liveIssue('testing');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'test-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition({ from: 'deploying', to: 'testing' }) as never);

    expect(applyTransitionMock).not.toHaveBeenCalled();
    expect(appendSkipChainEntryMock).not.toHaveBeenCalled();
    expect(dbInsert).toHaveBeenCalledTimes(1);
  });
});
