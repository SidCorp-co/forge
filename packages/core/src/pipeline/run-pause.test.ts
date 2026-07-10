import { beforeEach, describe, expect, it, vi } from 'vitest';

// db.update(pipelineRuns).set(...).where(...).returning() — scripted rows.
const updateReturning = vi.fn(async () => [] as unknown[]);
const updateSet = vi.fn(() => ({ where: () => ({ returning: updateReturning }) }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));
vi.mock('../db/client.js', () => ({ db: { update: dbUpdate } }));

const wsPublish = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...a: unknown[]) => wsPublish(...(a as [])) },
}));

const hookEmit = vi.fn(async () => undefined);
vi.mock('./hooks.js', () => ({
  hooks: { emit: (...a: unknown[]) => hookEmit(...(a as [])) },
}));

const { pauseRun, resumeRun, resumeRunsWhere } = await import('./run-pause.js');

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
