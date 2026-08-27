import { beforeEach, describe, expect, it, vi } from 'vitest';

// db.update(pipelineRuns).set(...).where(...).returning() — scripted rows.
const updateReturning = vi.fn(async () => [] as unknown[]);
const updateSet = vi.fn((_set: unknown) => ({ where: () => ({ returning: updateReturning }) }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));
const selectWhere = vi.fn(async () => [] as unknown[]);
const dbSelect = vi.fn(() => ({ from: () => ({ where: selectWhere }) }));
vi.mock('../db/client.js', () => ({ db: { update: dbUpdate, select: dbSelect } }));

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
  isLivePauseReason,
  LIVE_PAUSE_REASON_KINDS,
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
    // metadata SET always present on resume — it strips the pauseReason key
    // so a stale machine reason can never re-match a later operator pause.
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
    expect(hookEmit).not.toHaveBeenCalled(); // caller bus wins over global hooks
    expect(wsPublish).toHaveBeenCalledTimes(2);
  });
});

describe('pause-reason vocabulary', () => {
  it('every live kind round-trips through pauseReasonFor', () => {
    for (const kind of LIVE_PAUSE_REASON_KINDS) {
      expect(isLivePauseReason(pauseReasonFor(kind, 'developed'))).toBe(true);
    }
  });

  // cm:guard `reopen_cap` must stay unrecognised — RFC 0002 deleted that mechanism, and this assertion is what keeps a future edit from re-registering a kind whose resume path no longer exists
  it('a retired kind is not live, and neither is a bare or empty reason', () => {
    expect(isLivePauseReason('reopen_cap:developed')).toBe(false);
    expect(isLivePauseReason('missing_skill')).toBe(true);
    expect(isLivePauseReason('')).toBe(false);
    expect(isLivePauseReason(null)).toBe(false);
    expect(isLivePauseReason(undefined)).toBe(false);
  });
});

describe('resumeOrphanedPauses', () => {
  // cm:guard this is the whole point of the pass — forge-dev ISS-576/652 sat paused on `reopen_cap:developed` for 3 days after RFC 0002 deleted the cap, their queued triage jobs invisible to a picker that requires `r.status='running'`
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

  // cm:guard a live kind must be left alone — its own resume path owns it, and racing that path here would resume a run the guard is still waiting to clear
  it('leaves a run paused for a reason that still has an owner', async () => {
    selectWhere.mockResolvedValueOnce([
      {
        id: 'run-8',
        projectId: 'p1',
        issueId: 'i1',
        metadata: { pauseReason: 'missing_skill:plan' },
      },
    ]);

    const res = await resumeOrphanedPauses();

    expect(res).toEqual({ detected: 0, resumed: 0 });
    expect(updateSet).not.toHaveBeenCalled();
  });

  // cm:guard an operator pause carries NO pauseReason — resuming one would override a human decision from a sweep, which is the opposite of what this pass is for
  it('never touches a run with no pause reason at all', async () => {
    selectWhere.mockResolvedValueOnce([
      { id: 'run-7', projectId: 'p1', issueId: 'i1', metadata: {} },
    ]);

    const res = await resumeOrphanedPauses();

    expect(res).toEqual({ detected: 0, resumed: 0 });
    expect(updateSet).not.toHaveBeenCalled();
  });
});
