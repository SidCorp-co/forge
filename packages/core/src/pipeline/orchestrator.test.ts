import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unified thenable mock: each select() terminal consumes one `nextSelect` row.
const nextSelect = vi.fn();
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
const insertValues = vi.fn(() => {
  // Dual-shape: legacy jobs-insert chains via `.returning()`, ISS-105
  // skill-not-found path awaits the values() result directly.
  const obj: Record<string, unknown> = { returning: insertReturning };
  // biome-ignore lint/suspicious/noThenProperty: vitest thenable shim
  obj.then = (cb: (v: unknown) => unknown) => Promise.resolve().then(cb);
  return obj;
});
const dbInsert = vi.fn(() => ({ values: insertValues }));

const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => makeWhereChain() }) }),
    insert: dbInsert,
    update: dbUpdate,
  },
}));

const publishSpy = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishSpy },
}));

vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: vi.fn(), captureMessage: vi.fn() },
  isSentryEnabled: () => false,
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const enqueueMock = vi.fn(async () => {});
vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: (...a: unknown[]) => enqueueMock(...(a as [])),
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

// ISS-32 — orchestrator now imports the preventive-pattern query module,
// which transitively pulls config/env. Stub it so the unit test stays
// pure-mock and never evaluates the env validator.
const queryPreventiveMock = vi.fn(async () => []);
vi.mock('./ci-fix-pattern-query.js', () => ({
  queryPreventivePatterns: (...a: unknown[]) => queryPreventiveMock(...(a as [])),
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
};

type CreatedPayload = {
  issueId: string;
  projectId: string;
  actor: { type: 'user' | 'device'; id: string };
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
    snapshot: {},
    ...overrides,
  };
}

function cfgResolved(cfg: unknown) {
  // Mock project row: { agentConfig: { pipelineConfig: cfg }, ownerId }
  nextSelect.mockResolvedValueOnce([{ agentConfig: { pipelineConfig: cfg }, ownerId: 'u-owner' }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  nextSelect.mockReset();
});

describe('pipeline/orchestrator', () => {
  // Helper: queue the skill-loader's two selects (global skill + project
  // override) with a loadable result so considerEnqueue proceeds past
  // pre-flight.
  function skillLoaderOk() {
    nextSelect.mockResolvedValueOnce([
      { id: 'skill-id', skillMd: '# body', prompt: '', contentHash: 'h' },
    ]);
    nextSelect.mockResolvedValueOnce([]); // no project override → uses global
  }

  it('enqueues a plan job on open→confirmed when autoPlan is true', async () => {
    cfgResolved({ enabled: true, autoPlan: true }); // loadPipelineConfig
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    skillLoaderOk();
    insertReturning.mockResolvedValueOnce([{ id: 'new-job' }]);

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith('new-job');
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

  it('skips human-gated target statuses (waiting)', async () => {
    // No config fetch needed — resolveSkillForStatus returns null first.
    const bus = makeBus();
    // biome-ignore lint/suspicious/noExplicitAny: test-only cast
    await bus.emit('transition', transition({ to: 'waiting' }) as any);
    expect(dbInsert).not.toHaveBeenCalled();
    expect(nextSelect).not.toHaveBeenCalled();
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
    nextSelect.mockResolvedValueOnce([{ id: 'existing-job' }]); // findActiveJob

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('treats a unique-index violation on insert as a dedupe skip', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    nextSelect.mockResolvedValueOnce([]); // no existing in read path
    skillLoaderOk();
    insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('falls back to project owner for createdBy on device-triggered transitions', async () => {
    cfgResolved({ enabled: true, autoReview: true });
    nextSelect.mockResolvedValueOnce([]); // no existing
    skillLoaderOk();
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
    expect(enqueueMock).toHaveBeenCalledWith('job-x');
  });

  it('enqueues a triage job on issueCreated when autoTriage is true', async () => {
    cfgResolved({ enabled: true, autoTriage: true });
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    skillLoaderOk();
    insertReturning.mockResolvedValueOnce([{ id: 'triage-job' }]);

    const bus = makeBus();
    await bus.emit('issueCreated', issueCreated() as never);

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith('triage-job');
  });

  // ISS-105 — pre-flight rejection when `forge-<type>` is not loadable.
  it('escalates to pipeline_failed when the skill is not loadable (skill_not_found)', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    nextSelect.mockResolvedValueOnce([]); // resolveSkill: no global row → skill_not_found

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    // No jobs row inserted; no enqueue.
    expect(insertReturning).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();

    // Issue flipped to pipeline_failed.
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pipeline_failed' }),
    );

    // Operator surface: skill_not_found WS broadcast + comment.
    expect(publishSpy).toHaveBeenCalledWith(
      'project:proj-1',
      expect.objectContaining({
        event: 'pipeline.skill_not_found',
        data: expect.objectContaining({
          skillName: 'forge-plan',
          jobType: 'plan',
          reason: 'skill_not_found',
        }),
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('forge-plan'),
        isAi: true,
      }),
    );
  });

  it('escalates when override is present but blanked (skill_empty_body)', async () => {
    cfgResolved({ enabled: true, autoPlan: true });
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
    nextSelect.mockResolvedValueOnce([
      { id: 'sid', skillMd: '# global ok', prompt: '', contentHash: 'h' },
    ]);
    nextSelect.mockResolvedValueOnce([
      { skillMdOverride: '   ', contentHash: 'h-ov' },
    ]);

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pipeline_failed' }),
    );
    expect(publishSpy).toHaveBeenCalledWith(
      'project:proj-1',
      expect.objectContaining({
        event: 'pipeline.skill_not_found',
        data: expect.objectContaining({ reason: 'skill_empty_body' }),
      }),
    );
  });

  it('does not enqueue on issueCreated when autoTriage is false', async () => {
    cfgResolved({ enabled: true, autoTriage: false });

    const bus = makeBus();
    await bus.emit('issueCreated', issueCreated() as never);

    expect(dbInsert).not.toHaveBeenCalled();
  });
});
