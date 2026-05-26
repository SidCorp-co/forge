import { beforeEach, describe, expect, it, vi } from 'vitest';

// The backfill performs two SELECTs in sequence:
//   1. Candidates (issues × pipeline_runs join, filtered to stuck auto-stages
//      with no skill registration).
//   2. Pipeline configs for the unique projectIds returned in step 1.
// Stub `db.select()` to return the queued response for each call.
const selectQueue: unknown[][] = [];
function pushSelect(rows: unknown[]) {
  selectQueue.push(rows);
}
function buildSelectChain() {
  const rows = selectQueue.shift() ?? [];
  const final = async () => rows;
  return {
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          then: (onFulfilled: (v: unknown) => unknown) => final().then(onFulfilled),
        }),
      }),
      where: () => ({
        then: (onFulfilled: (v: unknown) => unknown) => final().then(onFulfilled),
      }),
    }),
  };
}

vi.mock('../db/client.js', () => ({
  db: { select: () => buildSelectChain() },
}));

const pauseMock = vi.fn(async () => ({ paused: true, alreadyPaused: false }));
const commentMock = vi.fn(async () => undefined);
vi.mock('./missing-skill-guard.js', () => ({
  PAUSE_REASON_PREFIX: 'missing_skill:',
  buildMissingSkillReason: (s: string) => `missing_skill:${s}`,
  pausePipelineRunMissingSkill: (...a: unknown[]) => pauseMock(...(a as [])),
  postMissingSkillComment: (...a: unknown[]) => commentMock(...(a as [])),
}));

const { backfillMissingSkillPauses } = await import('./missing-skill-backfill.js');

beforeEach(() => {
  selectQueue.length = 0;
  pauseMock.mockReset();
  pauseMock.mockResolvedValue({ paused: true, alreadyPaused: false });
  commentMock.mockReset();
});

describe('backfillMissingSkillPauses (ISS-238)', () => {
  it('returns zero counts when no stuck candidates exist', async () => {
    pushSelect([]); // candidates

    const result = await backfillMissingSkillPauses();
    expect(result).toEqual({ scanned: 0, paused: 0, alreadyPaused: 0, errored: 0 });
    expect(pauseMock).not.toHaveBeenCalled();
  });

  it('pauses runs and posts comments for candidates whose project has the toggle on', async () => {
    pushSelect([
      {
        issueId: 'iss-1',
        projectId: 'proj-1',
        status: 'developed',
        runId: 'run-1',
        currentStep: 'developed',
      },
    ]);
    pushSelect([
      {
        id: 'proj-1',
        agentConfig: { pipelineConfig: { enabled: true, autoReview: true } },
      },
    ]);

    const result = await backfillMissingSkillPauses();
    expect(result.scanned).toBe(1);
    expect(result.paused).toBe(1);
    expect(pauseMock).toHaveBeenCalledTimes(1);
    expect(commentMock).toHaveBeenCalledTimes(1);
  });

  it('skips candidates whose project pipelineConfig is disabled or toggle is off', async () => {
    pushSelect([
      {
        issueId: 'iss-1',
        projectId: 'proj-1',
        status: 'developed',
        runId: 'run-1',
        currentStep: 'developed',
      },
      {
        issueId: 'iss-2',
        projectId: 'proj-2',
        status: 'developed',
        runId: 'run-2',
        currentStep: 'developed',
      },
    ]);
    pushSelect([
      {
        id: 'proj-1',
        agentConfig: { pipelineConfig: { enabled: false, autoReview: true } },
      },
      {
        id: 'proj-2',
        agentConfig: { pipelineConfig: { enabled: true, autoReview: false } },
      },
    ]);

    const result = await backfillMissingSkillPauses();
    expect(result.scanned).toBe(2);
    expect(result.paused).toBe(0);
    expect(pauseMock).not.toHaveBeenCalled();
    expect(commentMock).not.toHaveBeenCalled();
  });

  it('counts already-paused candidates separately from newly paused ones', async () => {
    pushSelect([
      {
        issueId: 'iss-1',
        projectId: 'proj-1',
        status: 'developed',
        runId: 'run-1',
        currentStep: 'developed',
      },
    ]);
    pushSelect([
      {
        id: 'proj-1',
        agentConfig: { pipelineConfig: { enabled: true, autoReview: true } },
      },
    ]);
    pauseMock.mockResolvedValueOnce({ paused: false, alreadyPaused: true });

    const result = await backfillMissingSkillPauses();
    expect(result).toMatchObject({ scanned: 1, paused: 0, alreadyPaused: 1, errored: 0 });
    expect(commentMock).not.toHaveBeenCalled();
  });
});
