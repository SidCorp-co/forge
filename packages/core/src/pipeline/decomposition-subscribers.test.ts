import { beforeEach, describe, expect, it, vi } from 'vitest';

const findDecompositionChildren = vi.fn();
const findDecompositionParent = vi.fn();
vi.mock('./decomposition.js', async () => {
  const actual =
    await vi.importActual<typeof import('./decomposition.js')>('./decomposition.js');
  return {
    ...actual,
    findDecompositionChildren,
    findDecompositionParent,
  };
});

const applyStatusTransition = vi.fn();
vi.mock('../issues/apply-transition.js', () => ({
  applyStatusTransition,
}));

const triggerPipelineStepManual = vi.fn();
vi.mock('./orchestrator.js', () => ({
  triggerPipelineStepManual,
}));

vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => false,
  Sentry: { addBreadcrumb: vi.fn() },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// db mock — chained: db.select().from().where().limit() and db.update().set().where()
// and db.insert().values()
const updateSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) }));
const updateChain = { set: updateSet };
const dbUpdate = vi.fn(() => updateChain);
const dbInsert = vi.fn(() => ({ values: vi.fn().mockResolvedValue([]) }));

const dbSelect = vi.fn();

function installDefaultDbSelect(): void {
  // Default: every chain resolves to a single owner row. Tests that need a
  // different sequence override via mockImplementationOnce BEFORE the bus
  // emit runs.
  dbSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({ limit: async () => [{ ownerId: 'owner-1' }] }),
    }),
  }));
}

vi.mock('../db/client.js', () => ({
  db: {
    select: dbSelect,
    update: dbUpdate,
    insert: dbInsert,
  },
}));

const { HooksBus } = await import('./hooks.js');
const { registerDecompositionSubscribers } = await import('./decomposition-subscribers.js');

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHILD_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function makeBus() {
  const bus = new HooksBus();
  registerDecompositionSubscribers(bus);
  return bus;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbSelect.mockReset();
  installDefaultDbSelect();
  findDecompositionChildren.mockReset();
  findDecompositionParent.mockReset();
  applyStatusTransition.mockReset();
  applyStatusTransition.mockResolvedValue(undefined);
  triggerPipelineStepManual.mockReset();
  triggerPipelineStepManual.mockResolvedValue({ jobId: 'job-1', type: 'test' });
});

describe('cascade approve', () => {
  it('flips draft children to approved when parent transitions waiting → approved', async () => {
    findDecompositionChildren.mockResolvedValueOnce([
      { id: CHILD_A, status: 'draft', projectId: PROJECT_ID },
      { id: CHILD_B, status: 'draft', projectId: PROJECT_ID },
      { id: CHILD_C, status: 'draft', projectId: PROJECT_ID },
    ]);
    // Subsequent handlers also call findDecompositionParent/Children — return null/[].
    findDecompositionParent.mockResolvedValue(null);
    findDecompositionChildren.mockResolvedValue([]);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: PARENT_ID,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'waiting',
      to: 'approved',
      reopenCount: 0,
    });

    expect(applyStatusTransition).toHaveBeenCalledTimes(3);
    for (const call of applyStatusTransition.mock.calls) {
      expect(call[1]).toBe('approved');
      expect(call[3]).toEqual({ skip: true });
    }
  });

  it('cascades a parked draft child to approved (ISS-393: no manualHold clearing)', async () => {
    findDecompositionChildren.mockResolvedValueOnce([
      { id: CHILD_A, status: 'draft', projectId: PROJECT_ID },
    ]);
    findDecompositionParent.mockResolvedValue(null);
    findDecompositionChildren.mockResolvedValue([]);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: PARENT_ID,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'waiting',
      to: 'approved',
      reopenCount: 0,
    });

    expect(applyStatusTransition).toHaveBeenCalledTimes(1);
    expect(applyStatusTransition.mock.calls[0]?.[1]).toBe('approved');
  });

  it('does nothing for transitions that do not enter approved', async () => {
    findDecompositionChildren.mockResolvedValue([]);
    findDecompositionParent.mockResolvedValue(null);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: PARENT_ID,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'open',
      to: 'confirmed',
      reopenCount: 0,
    });

    expect(applyStatusTransition).not.toHaveBeenCalled();
  });

  it('cascades on_hold children (skill-created) when parent enters approved from on_hold (drift-tolerant)', async () => {
    findDecompositionChildren.mockResolvedValueOnce([
      { id: CHILD_A, status: 'on_hold', projectId: PROJECT_ID },
    ]);
    findDecompositionParent.mockResolvedValue(null);
    findDecompositionChildren.mockResolvedValue([]);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: PARENT_ID,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'on_hold',
      to: 'approved',
      reopenCount: 0,
    });

    expect(applyStatusTransition).toHaveBeenCalledTimes(1);
    expect(applyStatusTransition.mock.calls[0]?.[0]?.id).toBe(CHILD_A);
  });

  it('skips children that are not parked (e.g. already in_progress)', async () => {
    findDecompositionChildren.mockResolvedValueOnce([
      { id: CHILD_A, status: 'in_progress', projectId: PROJECT_ID },
      { id: CHILD_B, status: 'draft', projectId: PROJECT_ID },
    ]);
    findDecompositionParent.mockResolvedValue(null);
    findDecompositionChildren.mockResolvedValue([]);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: PARENT_ID,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'waiting',
      to: 'approved',
      reopenCount: 0,
    });

    expect(applyStatusTransition).toHaveBeenCalledTimes(1);
    expect(applyStatusTransition.mock.calls[0]?.[0]?.id).toBe(CHILD_B);
  });

  // ISS-130 regression guard: a child at `open` must NOT be cascaded — only
  // `draft`/`on_hold` are parking statuses. If decomposition ever lands a child at
  // `open` again (the original bug), forge-triage would have already grabbed
  // it before the cascade could fire; even if the cascade fires first, the
  // filter must reject `open` so we never silently double-approve an issue
  // that the orchestrator was about to triage.
  it('does NOT cascade children stuck at open (filter is draft-only)', async () => {
    findDecompositionChildren.mockResolvedValueOnce([
      { id: CHILD_A, status: 'open', projectId: PROJECT_ID },
    ]);
    findDecompositionParent.mockResolvedValue(null);
    findDecompositionChildren.mockResolvedValue([]);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: PARENT_ID,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'waiting',
      to: 'approved',
      reopenCount: 0,
    });

    expect(applyStatusTransition).not.toHaveBeenCalled();
  });
});

describe('watcher children → staging', () => {
  it('does not fire when not all siblings are ready', async () => {
    // cascade-approve handler early-returns for non-waiting→approved transitions
    // and never calls findDecompositionChildren. Only watcher consumes the
    // children mock here.
    findDecompositionParent.mockResolvedValueOnce({
      id: PARENT_ID,
      status: 'approved',
      projectId: PROJECT_ID,
      issSeq: 99,
    });
    findDecompositionChildren.mockResolvedValueOnce([
      { id: CHILD_A, status: 'staging', projectId: PROJECT_ID },
      { id: CHILD_B, status: 'in_progress', projectId: PROJECT_ID },
    ]);
    // close cascade — payload.to !== 'closed', early returns.

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: CHILD_A,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'developed',
      to: 'staging',
      reopenCount: 0,
    });

    expect(triggerPipelineStepManual).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('fires once when LAST child reaches staging — posts comment + re-triggers parent', async () => {
    // Watcher fires; idempotency check (1st select) must return [] (no prior),
    // device lookup (2nd select) must return owner.
    dbSelect.mockReset();
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }), // idempotency: no prior comment
    }));
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ ownerId: 'owner-1' }] }) }), // device
    }));

    findDecompositionParent.mockResolvedValueOnce({
      id: PARENT_ID,
      status: 'approved',
      projectId: PROJECT_ID,
      issSeq: 99,
    });
    findDecompositionChildren.mockResolvedValueOnce([
      { id: CHILD_A, status: 'staging', projectId: PROJECT_ID },
      { id: CHILD_B, status: 'staging', projectId: PROJECT_ID },
      { id: CHILD_C, status: 'staging', projectId: PROJECT_ID },
    ]);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: CHILD_C,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'developed',
      to: 'staging',
      reopenCount: 0,
    });

    expect(triggerPipelineStepManual).toHaveBeenCalledTimes(1);
    expect(triggerPipelineStepManual.mock.calls[0]?.[0]).toMatchObject({
      issueId: PARENT_ID,
      status: 'approved',
    });
    expect(dbInsert).toHaveBeenCalled();
  });

  it('does not fire for issues without a decomposition parent', async () => {
    findDecompositionParent.mockResolvedValueOnce(null);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: 'iss-loner',
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'developed',
      to: 'staging',
      reopenCount: 0,
    });

    expect(triggerPipelineStepManual).not.toHaveBeenCalled();
  });

  it('skips re-firing when a prior watcher comment already exists (idempotency)', async () => {
    dbSelect.mockReset();
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'prior-comment-1' }] }) }),
    }));

    findDecompositionParent.mockResolvedValueOnce({
      id: PARENT_ID,
      status: 'approved',
      projectId: PROJECT_ID,
      issSeq: 99,
    });
    findDecompositionChildren.mockResolvedValueOnce([
      { id: CHILD_A, status: 'released', projectId: PROJECT_ID },
      { id: CHILD_B, status: 'staging', projectId: PROJECT_ID },
    ]);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: CHILD_A,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'staging',
      to: 'released',
      reopenCount: 0,
    });

    expect(dbInsert).not.toHaveBeenCalled();
    expect(triggerPipelineStepManual).not.toHaveBeenCalled();
  });
});

describe('close cascade', () => {
  it('forces non-closed children to closed when parent → closed', async () => {
    // cascade-approve early-returns (payload.to !== 'approved'), so it never
    // calls findDecompositionChildren — no placeholder mock needed.
    // watcher — closed IS in DECOMP_CHILD_READY_STATUSES, so the handler does
    // call findDecompositionParent; return null so it bails before reading
    // siblings.
    findDecompositionParent.mockResolvedValueOnce(null);
    // close cascade fetch — the only consumer of findDecompositionChildren here.
    findDecompositionChildren.mockResolvedValueOnce([
      { id: CHILD_A, status: 'in_progress', projectId: PROJECT_ID },
      { id: CHILD_B, status: 'closed', projectId: PROJECT_ID },
      { id: CHILD_C, status: 'staging', projectId: PROJECT_ID },
    ]);

    const bus = makeBus();
    await bus.emit('transition', {
      issueId: PARENT_ID,
      projectId: PROJECT_ID,
      actor: { type: 'device', id: DEVICE_ID },
      from: 'released',
      to: 'closed',
      reopenCount: 0,
    });

    expect(applyStatusTransition).toHaveBeenCalledTimes(2);
    const targetIds = applyStatusTransition.mock.calls.map((c) => c[0]?.id);
    expect(targetIds).toContain(CHILD_A);
    expect(targetIds).toContain(CHILD_C);
    expect(targetIds).not.toContain(CHILD_B);
    for (const call of applyStatusTransition.mock.calls) {
      expect(call[1]).toBe('closed');
      expect(call[3]).toEqual({ skip: true });
    }
  });
});
