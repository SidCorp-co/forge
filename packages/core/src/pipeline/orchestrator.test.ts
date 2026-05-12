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
const dbInsert = vi.fn(() => ({
  values: () => ({ returning: insertReturning }),
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => makeWhereChain() }) }),
    insert: dbInsert,
  },
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
  it('enqueues a plan job on open→confirmed when autoPlan is true', async () => {
    cfgResolved({ enabled: true, autoPlan: true }); // loadPipelineConfig
    nextSelect.mockResolvedValueOnce([]); // findActiveJob → none
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
    insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));

    const bus = makeBus();
    await bus.emit('transition', transition() as never);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('falls back to project owner for createdBy on device-triggered transitions', async () => {
    cfgResolved({ enabled: true, autoReview: true });
    nextSelect.mockResolvedValueOnce([]); // no existing
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
    insertReturning.mockResolvedValueOnce([{ id: 'triage-job' }]);

    const bus = makeBus();
    await bus.emit('issueCreated', issueCreated() as never);

    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith('triage-job');
  });

  it('does not enqueue on issueCreated when autoTriage is false', async () => {
    cfgResolved({ enabled: true, autoTriage: false });

    const bus = makeBus();
    await bus.emit('issueCreated', issueCreated() as never);

    expect(dbInsert).not.toHaveBeenCalled();
  });
});
