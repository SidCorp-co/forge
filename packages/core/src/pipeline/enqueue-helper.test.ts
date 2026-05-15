import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  enqueueJob: vi.fn(async () => {}),
  setCurrentStep: vi.fn(async () => {}),
}));

vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: () => ({ returning: mocks.insertReturning }),
    }),
  },
}));

vi.mock('../jobs/enqueue.js', () => ({
  enqueueJob: mocks.enqueueJob,
}));

vi.mock('./runs.js', () => ({
  setCurrentStep: mocks.setCurrentStep,
}));

import { ActiveJobConflictError, insertAndEnqueueJob } from './enqueue-helper.js';

describe('insertAndEnqueueJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a job row, sets current step, enqueues pg-boss, and returns jobId', async () => {
    mocks.insertReturning.mockResolvedValueOnce([{ id: 'j-1' }]);

    const result = await insertAndEnqueueJob({
      projectId: 'p-1',
      issueId: 'i-1',
      pipelineRunId: 'r-1',
      createdBy: 'u-1',
      type: 'plan',
      skillName: 'forge-plan',
      promptString: '/forge-plan i-1',
      payloadExtras: { transition: { from: 'open', to: 'confirmed' } },
    });

    expect(result).toEqual({ jobId: 'j-1' });
    expect(mocks.setCurrentStep).toHaveBeenCalledWith('r-1', 'plan');
    expect(mocks.enqueueJob).toHaveBeenCalledWith('j-1');
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
        type: 'plan',
        skillName: 'forge-plan',
        promptString: '/forge-plan i-1',
        payloadExtras: {},
        resolveRacingJobId: resolveRacing,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ActiveJobConflictError);
    expect((thrown as ActiveJobConflictError).existingJobId).toBe('race-job-9');
    expect((thrown as ActiveJobConflictError).type).toBe('plan');
    expect(resolveRacing).toHaveBeenCalledTimes(1);
    expect(mocks.setCurrentStep).not.toHaveBeenCalled();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('rethrows non-unique-violation errors', async () => {
    mocks.insertReturning.mockRejectedValueOnce(new Error('boom'));

    await expect(
      insertAndEnqueueJob({
        projectId: 'p-1',
        issueId: 'i-1',
        pipelineRunId: 'r-1',
        createdBy: 'u-1',
        type: 'plan',
        skillName: 'forge-plan',
        promptString: '/forge-plan i-1',
        payloadExtras: {},
      }),
    ).rejects.toThrow('boom');
  });
});
