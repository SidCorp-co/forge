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
    applyTransitionMock(
      a[0],
      a[1] as string,
      a[2],
      a[3] as { skip?: boolean } | undefined,
    ),
}));

// ISS-110 — verify Sentry breadcrumb emission per skip hop.
const sentryAddBreadcrumb = vi.fn<(crumb: { category: string; data: Record<string, unknown> }) => void>();
vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: (...a: unknown[]) => sentryAddBreadcrumb(a[0] as { category: string; data: Record<string, unknown> }) },
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

const queryPreventiveMock = vi.fn(async () => []);
vi.mock('./ci-fix-pattern-query.js', () => ({
  queryPreventivePatterns: (...a: unknown[]) => queryPreventiveMock(...(a as [])),
}));

// ISS-108 — orchestrator resolves skillName from the DB via
// createProjectSkillResolver. Stubbing the module keeps the orchestrator unit
// test pure (no skill_registrations rows needed) and lets each case control
// whether a registration exists for the target stage.
const resolverResolve = vi.fn();
const createProjectSkillResolverMock = vi.fn((_projectId: string) => ({ resolve: resolverResolve }));
vi.mock('./skill-mapping.js', async () => {
  const actual = await vi.importActual<typeof import('./skill-mapping.js')>('./skill-mapping.js');
  return {
    ...actual,
    createProjectSkillResolver: (projectId: string) => createProjectSkillResolverMock(projectId),
  };
});

const { HooksBus } = await import('./hooks.js');
const { registerPipelineOrchestrator } = await import('./orchestrator.js');

type TransitionPayload = {
  issueId: string;
  projectId: string;
  actor: { type: 'user' | 'device'; id: string };
  from: string;
  to: string;
  reopenCount: number;
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
  nextSelect.mockResolvedValueOnce([{ agentConfig: { pipelineConfig: cfg }, ownerId: 'u-owner' }]);
}

function skillRegistered(skillName: string, type: string, toggle: string) {
  resolverResolve.mockResolvedValueOnce({ skillName, type, toggle });
}

function noSkillRegistered() {
  resolverResolve.mockResolvedValueOnce(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  nextSelect.mockReset();
  // mockReset wipes the default impl; restore it so unmocked SELECT calls
  // (eg. loadIssueSnapshot when the test only cares about the dispatch path)
  // return [] instead of undefined and TypeError-destructuring.
  nextSelect.mockImplementation(() => [] as unknown[]);
  resolverResolve.mockReset();
});

describe('pipeline/orchestrator', () => {
  it('enqueues a plan job on open→confirmed when autoPlan is true', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    skillRegistered('forge-plan', 'plan', 'autoPlan');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'new-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'new-job' }));
  });

  it('uses the registered skill name in the inserted job payload', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    skillRegistered('custom-planner', 'plan', 'autoPlan');
    nextSelect.mockResolvedValueOnce([]);
    insertReturning.mockResolvedValueOnce([{ id: 'job-x' }]);

    const valuesSpy = vi.fn(() => ({ returning: insertReturning }));
    dbInsert.mockImplementationOnce(() => ({ values: valuesSpy }));

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

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
    await bus.emit('transition', transition() as never);

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

  it('skips when no skill is registered for the auto stage', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    noSkillRegistered();

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
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

  it('dedupes when an active job of the same type already exists', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    skillRegistered('forge-plan', 'plan', 'autoPlan');
    nextSelect.mockResolvedValueOnce([{ id: 'existing-job' }]); // findActiveJob

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('treats a unique-index violation on insert as a dedupe skip', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    skillRegistered('forge-plan', 'plan', 'autoPlan');
    nextSelect.mockResolvedValueOnce([]);
    insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('falls back to project owner for createdBy on device-triggered transitions', async () => {
    cfgResolved({ enabled: true, autoReview: true });
    skillRegistered('forge-review', 'review', 'autoReview');
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

  it('enqueues a clarify job on open→needs_info when autoClarify is true (ISS-171)', async () => {
    cfgResolved({ enabled: true, autoClarify: true });
    skillRegistered('forge-clarify', 'clarify', 'autoClarify');
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'clarify-job' }]);

    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({ from: 'open', to: 'needs_info' }) as never,
    );

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'clarify-job' }));
  });

  it('does not enqueue on open→needs_info when autoClarify is false', async () => {
    cfgResolved({ enabled: true, autoClarify: false });

    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({ from: 'open', to: 'needs_info' }) as never,
    );

    expect(dbInsert).not.toHaveBeenCalled();
    expect(resolverResolve).not.toHaveBeenCalled();
  });

  it('enqueues a triage job on issueCreated when autoTriage is true', async () => {
    cfgResolved({ enabled: true, autoTriage: true });
    skillRegistered('forge-triage', 'triage', 'autoTriage');
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
    await bus.emit(
      'transition',
      transition({ from: 'in_progress', to: 'developed' }) as never,
    );

    expect(applyTransitionMock).toHaveBeenCalledTimes(1);
    expect(applyTransitionMock.mock.calls[0]?.[1]).toBe('testing');
    // Review blocker #1: the soft-skip path must pass `{ skip: true }` so the
    // state-machine bypass kicks in. Without this, applyStatusTransition
    // throws ILLEGAL_TRANSITION for developed → testing and the issue is
    // stranded forever at `developed`.
    expect(applyTransitionMock.mock.calls[0]?.[3]).toEqual({ skip: true });
    expect(sentryAddBreadcrumb).toHaveBeenCalledTimes(1);
    expect(sentryAddBreadcrumb.mock.calls[0]?.[0]).toMatchObject({
      category: 'pipeline_run.status_changed',
      data: { reason: 'skipped-disabled', fromStatus: 'developed', toStatus: 'testing' },
    });
    // considerEnqueue runs second; the disabled-stage guard short-circuits it.
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('walks a two-stage disabled chain one hop at a time (developed → testing → pass)', async () => {
    cfgResolved({
      enabled: true,
      states: {
        developed: { enabled: false },
        testing: { enabled: false },
      },
    });
    nextSelect.mockResolvedValueOnce([
      { id: 'iss-1', projectId: 'proj-1', status: 'developed', reopenCount: 0 },
    ]);

    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({ from: 'in_progress', to: 'developed' }) as never,
    );

    // Per-hop emission gives downstream subscribers (and Sentry) the full
    // status history — AC #4 requires a breadcrumb per skip transition.
    expect(applyTransitionMock).toHaveBeenCalledTimes(2);
    expect(applyTransitionMock.mock.calls[0]?.[1]).toBe('testing');
    expect(applyTransitionMock.mock.calls[1]?.[1]).toBe('pass');
    expect(sentryAddBreadcrumb).toHaveBeenCalledTimes(2);
    expect(sentryAddBreadcrumb.mock.calls[0]?.[0]).toMatchObject({
      data: { reason: 'skipped-disabled', fromStatus: 'developed', toStatus: 'testing' },
    });
    expect(sentryAddBreadcrumb.mock.calls[1]?.[0]).toMatchObject({
      data: { reason: 'skipped-disabled', fromStatus: 'testing', toStatus: 'pass' },
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
    // No issue lookup because autoSkip bails before that. considerEnqueue then
    // proceeds normally — needs a no-active-job select and the insert.
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    insertReturning.mockResolvedValueOnce([{ id: 'review-job' }]);

    const bus = makeBus();
    await bus.emit(
      'transition',
      transition({ from: 'in_progress', to: 'developed' }) as never,
    );

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
    await bus.emit(
      'transition',
      transition({ from: 'in_progress', to: 'developed' }) as never,
    );

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
