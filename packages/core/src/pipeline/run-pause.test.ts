import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateReturning = vi.fn(async () => [] as unknown[]);
const updateSet = vi.fn((_set: unknown) => ({ where: () => ({ returning: updateReturning }) }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));
const selectWhere = vi.fn(async () => [] as unknown[]);
const dbSelect = vi.fn(() => ({ from: () => ({ where: selectWhere }) }));
const dbStub = {
  update: dbUpdate,
  select: dbSelect,
  execute: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbStub)),
};
vi.mock('../db/client.js', () => ({ db: dbStub }));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const wsPublish = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...a: unknown[]) => wsPublish(...(a as [])) },
}));

const hookEmit = vi.fn(async () => undefined);
vi.mock('./hooks.js', () => ({
  hooks: { emit: (...a: unknown[]) => hookEmit(...(a as [])) },
}));

const {
  describePause,
  HUMAN_RESUMED_PAUSE_KINDS,
  isLivePauseReason,
  LIVE_PAUSE_REASON_KINDS,
  MACHINE_RESUMED_PAUSE_KINDS,
  pauseResumesItself,
  pauseReasonFor,
  pauseRun,
  resumeOrphanedPauses,
  resumeRun,
  resumeRunsWhere,
} = await import('./run-pause.js');

const RUN = {
  id: 'run-1',
  projectId: 'proj-1',
  issueId: 'iss-1',
  kind: 'issue',
  status: 'paused',
  currentStep: 'plan',
  startedAt: new Date('2026-01-01T00:00:00Z'),
  finishedAt: null,
  metadata: {},
};

beforeEach(() => {
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
  updateSet.mockClear();
  dbUpdate.mockClear();
  wsPublish.mockClear();
  hookEmit.mockClear();
});

describe('pipeline/run-pause', () => {
  it('pauseRun returns null and emits nothing when the CAS hits 0 rows', async () => {
    const row = await pauseRun({ runId: 'run-1' });
    expect(row).toBeNull();
    expect(hookEmit).not.toHaveBeenCalled();
    expect(wsPublish).not.toHaveBeenCalled();
  });

  it('pauseRun emits BOTH the hook and the WS broadcast on an effective pause', async () => {
    updateReturning.mockResolvedValueOnce([{ ...RUN, status: 'paused' }]);
    const row = await pauseRun({ runId: 'run-1' });
    expect(row?.status).toBe('paused');
    expect(hookEmit).toHaveBeenCalledWith(
      'pipelineRunStatusChanged',
      expect.objectContaining({
        runId: 'run-1',
        projectId: 'proj-1',
        issueId: 'iss-1',
        kind: 'issue',
        fromStatus: 'running',
        toStatus: 'paused',
      }),
    );
    expect(wsPublish).toHaveBeenCalledWith(
      'project:proj-1',
      expect.objectContaining({
        event: 'pipeline_run.status_changed',
        data: expect.objectContaining({ runId: 'run-1', status: 'paused' }),
      }),
    );
  });

  it('pauseRun without pauseReason does not touch metadata (operator pause)', async () => {
    updateReturning.mockResolvedValueOnce([{ ...RUN, status: 'paused' }]);
    await pauseRun({ runId: 'run-1' });
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.status).toBe('paused');
    expect(setArg.metadata).toBeUndefined();
  });

  it('pauseRun with pauseReason merges it into metadata', async () => {
    updateReturning.mockResolvedValueOnce([{ ...RUN, status: 'paused' }]);
    await pauseRun({ runId: 'run-1', pauseReason: 'missing_skill:plan' });
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.metadata).toBeDefined();
  });

  it('resumeRun clears pauseReason and emits paused→running side effects', async () => {
    updateReturning.mockResolvedValueOnce([{ ...RUN, status: 'running' }]);
    const row = await resumeRun({ runId: 'run-1' });
    expect(row?.status).toBe('running');
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.metadata).toBeDefined();
    expect(hookEmit).toHaveBeenCalledWith(
      'pipelineRunStatusChanged',
      expect.objectContaining({ fromStatus: 'paused', toStatus: 'running' }),
    );
    expect(wsPublish).toHaveBeenCalledTimes(1);
  });

  it('resumeRunsWhere emits per resumed row and routes through a caller bus', async () => {
    updateReturning.mockResolvedValueOnce([
      { ...RUN, id: 'run-1', status: 'running' },
      { ...RUN, id: 'run-2', status: 'running' },
    ]);
    const busEmit = vi.fn(async () => undefined);
    const rows = await resumeRunsWhere(undefined, {
      bus: { emit: busEmit } as never,
    });
    expect(rows).toHaveLength(2);
    expect(busEmit).toHaveBeenCalledTimes(2);
    expect(hookEmit).not.toHaveBeenCalled();
    expect(wsPublish).toHaveBeenCalledTimes(2);
  });
});

describe('pause-reason vocabulary', () => {
  it('every live kind round-trips through pauseReasonFor', () => {
    for (const kind of LIVE_PAUSE_REASON_KINDS) {
      expect(isLivePauseReason(pauseReasonFor(kind, 'developed'))).toBe(true);
    }
  });

  it('a retired kind is not live, and neither is a bare or empty reason', () => {
    expect(isLivePauseReason('reopen_cap:developed')).toBe(false);
    expect(isLivePauseReason('missing_skill')).toBe(false);
    expect(isLivePauseReason('stage_stalled')).toBe(true);
    expect(isLivePauseReason('')).toBe(false);
    expect(isLivePauseReason(null)).toBe(false);
    expect(isLivePauseReason(undefined)).toBe(false);
  });
});

describe('resumeOrphanedPauses', () => {
  it('frees a run whose pause reason has no owner left', async () => {
    selectWhere.mockResolvedValueOnce([
      {
        id: 'run-9',
        projectId: 'p1',
        issueId: 'i1',
        metadata: { pauseReason: 'reopen_cap:developed' },
      },
    ]);
    updateReturning.mockResolvedValueOnce([{ ...RUN, id: 'run-9', status: 'running' }]);

    const res = await resumeOrphanedPauses();

    expect(res).toEqual({ detected: 1, resumed: 1 });
    expect(updateSet).toHaveBeenCalledTimes(1);
  });

  it('leaves a run paused for a reason that still has an owner', async () => {
    selectWhere.mockResolvedValueOnce([
      {
        id: 'run-8',
        projectId: 'p1',
        issueId: 'i1',
        metadata: { pauseReason: 'stage_stalled:developed' },
      },
    ]);

    const res = await resumeOrphanedPauses();

    expect(res).toEqual({ detected: 0, resumed: 0 });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('never touches a run with no pause reason at all', async () => {
    selectWhere.mockResolvedValueOnce([
      { id: 'run-7', projectId: 'p1', issueId: 'i1', metadata: {} },
    ]);

    const res = await resumeOrphanedPauses();

    expect(res).toEqual({ detected: 0, resumed: 0 });
    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe('pauseResumesItself (ISS-879)', () => {
  it('is false for every kind while no kind has a resume path in this build', () => {
    expect(pauseResumesItself('missing_skill:open')).toBe(false);
    expect(pauseResumesItself('stage_stalled:awaiting_release')).toBe(false);
    expect(pauseResumesItself('reopen_cap:3')).toBe(false);
  });

  it('is false for an operator pause, which has no reason at all', () => {
    expect(pauseResumesItself(null)).toBe(false);
    expect(pauseResumesItself(undefined)).toBe(false);
    expect(pauseResumesItself('')).toBe(false);
  });

  it('leaves LIVE_PAUSE_REASON_KINDS the exact union of the two halves', () => {
    expect([...LIVE_PAUSE_REASON_KINDS]).toEqual([
      ...MACHINE_RESUMED_PAUSE_KINDS,
      ...HUMAN_RESUMED_PAUSE_KINDS,
    ]);
    expect([...LIVE_PAUSE_REASON_KINDS].sort()).toEqual(['stage_stalled']);
    expect(isLivePauseReason('stage_stalled:awaiting_release')).toBe(true);
    expect(isLivePauseReason('missing_skill:open')).toBe(false);
  });
});

describe('describePause — ISS-853, the one reader of a pauseReason for display', () => {
  it('reads an absent reason as an operator pause with no kind to name', () => {
    expect(describePause(null)).toEqual({ kind: null, detail: null, resumer: 'operator' });
    expect(describePause(undefined).resumer).toBe('operator');
    expect(describePause('').resumer).toBe('operator');
  });

  it('splits a live kind into its kind and its detail, and hands it to a person', () => {
    expect(describePause('stage_stalled:awaiting_release')).toEqual({
      kind: 'stage_stalled',
      detail: 'awaiting_release',
      resumer: 'operator',
    });
  });

  it('gives a retired kind to the sweeper, which is what actually frees it', () => {
    expect(describePause('missing_skill:open')).toEqual({
      kind: 'missing_skill',
      detail: 'open',
      resumer: 'sweeper',
    });
    expect(describePause('reopen_cap:3').resumer).toBe('sweeper');
  });

  it('splits on the first colon only, and reads a bare kind as detail-free', () => {
    expect(describePause('stage_stalled:code:attempt-2').detail).toBe('code:attempt-2');
    expect(describePause('stage_stalled')).toEqual({
      kind: 'stage_stalled',
      detail: null,
      resumer: 'operator',
    });
  });

  it('reports `machine` for every kind something in this build resumes', () => {
    for (const kind of MACHINE_RESUMED_PAUSE_KINDS) {
      expect(describePause(`${kind}:x`).resumer).toBe('machine');
    }
    expect(MACHINE_RESUMED_PAUSE_KINDS).toEqual([]);
  });
});
