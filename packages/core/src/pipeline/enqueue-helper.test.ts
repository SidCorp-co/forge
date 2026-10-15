import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  setCurrentStep: vi.fn(async () => {}),
}));

const wakeMastersForProject = vi.fn(async () => ({ boxes: 1, delivered: 1 }));
vi.mock('../ws/master-wake.js', () => ({
  wakeMastersForProject: (...a: unknown[]) => wakeMastersForProject(...(a as [])),
}));

vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: () => ({ returning: mocks.insertReturning }),
    }),
  },
}));

vi.mock('./runs.js', () => ({
  setCurrentStep: mocks.setCurrentStep,
}));

// The job is written through the admission door; its run lock is proved against Postgres in
// `tests/integration/job-admission-race-e2e.test.ts`, so here the door writes through the mock.
vi.mock('../jobs/admit.js', () => ({
  admitJob: async () => ((await mocks.insertReturning()) as { id: string }[])[0],
}));

import { ActiveJobConflictError, insertAndEnqueueJob } from './enqueue-helper.js';

describe('insertAndEnqueueJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a job row, sets current step, wakes the masters, and returns jobId', async () => {
    mocks.insertReturning.mockResolvedValueOnce([{ id: 'j-1' }]);

    const result = await insertAndEnqueueJob({
      projectId: 'p-1',
      issueId: 'i-1',
      pipelineRunId: 'r-1',
      createdBy: 'u-1',
      type: 'smoke',
      skillName: 'forge-smoke',
      promptString: '/forge-smoke i-1',
      payloadExtras: { transition: { from: 'open', to: 'confirmed' } },
    });

    expect(result).toEqual({ jobId: 'j-1' });
    expect(mocks.setCurrentStep).toHaveBeenCalledWith('r-1', 'smoke');
    expect(wakeMastersForProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p-1', issueId: 'i-1' }),
    );
  });

  it('throws ActiveJobConflictError with racingJobId on unique violation (23505)', async () => {
    mocks.insertReturning.mockRejectedValueOnce({ code: '23505', detail: 'duplicate' });
    const resolveRacing = vi.fn(async () => 'race-job-9');

    let thrown: unknown;
    try {
      await insertAndEnqueueJob({
        projectId: 'p-1',
        issueId: 'i-1',
        pipelineRunId: 'r-1',
        createdBy: 'u-1',
        type: 'smoke',
        skillName: 'forge-smoke',
        promptString: '/forge-smoke i-1',
        payloadExtras: {},
        resolveRacingJobId: resolveRacing,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ActiveJobConflictError);
    expect((thrown as ActiveJobConflictError).existingJobId).toBe('race-job-9');
    expect((thrown as ActiveJobConflictError).type).toBe('smoke');
    expect(resolveRacing).toHaveBeenCalledTimes(1);
    expect(mocks.setCurrentStep).not.toHaveBeenCalled();
    expect(wakeMastersForProject).not.toHaveBeenCalled();
  });

  it('rethrows non-unique-violation errors', async () => {
    mocks.insertReturning.mockRejectedValueOnce(new Error('boom'));

    await expect(
      insertAndEnqueueJob({
        projectId: 'p-1',
        issueId: 'i-1',
        pipelineRunId: 'r-1',
        createdBy: 'u-1',
        type: 'smoke',
        skillName: 'forge-smoke',
        promptString: '/forge-smoke i-1',
        payloadExtras: {},
      }),
    ).rejects.toThrow('boom');
  });
});
