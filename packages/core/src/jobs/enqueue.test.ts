import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn(async () => 'msg-1');
const insertMock = vi.fn();

vi.mock('../queue/boss.js', () => ({
  boss: { send: sendMock },
}));

vi.mock('../db/client.js', () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

vi.mock('../pipeline/runs.js', () => ({
  openIssueRun: vi.fn().mockResolvedValue({ id: 'run-1', startedAt: new Date() }),
  openOneShotRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
  closeRun: vi.fn().mockResolvedValue(undefined),
  closeRunIfOneShot: vi.fn().mockResolvedValue(undefined),
  closeOpenRunForIssue: vi.fn().mockResolvedValue(undefined),
  setCurrentStep: vi.fn().mockResolvedValue(undefined),
  setCurrentStepForOpenIssueRun: vi.fn().mockResolvedValue(undefined),
}));

const { enqueueJob, enqueuePmJob, createPmJob } = await import('./enqueue.js');
const { JOB_QUEUE_NAME, PM_QUEUE_NAME } = await import('./queue-name.js');

describe('jobs/enqueue', () => {
  beforeEach(() => {
    sendMock.mockClear();
    insertMock.mockReset();
  });

  it('sends to the forge.jobs queue with the jobId as singletonKey', async () => {
    await enqueueJob('job-1');
    expect(sendMock).toHaveBeenCalledWith(
      JOB_QUEUE_NAME,
      { jobId: 'job-1' },
      expect.objectContaining({ singletonKey: 'job-1' }),
    );
  });

  it('passes startAfter when provided', async () => {
    await enqueueJob('job-2', { startAfterSeconds: 60 });
    expect(sendMock).toHaveBeenCalledWith(
      JOB_QUEUE_NAME,
      { jobId: 'job-2' },
      expect.objectContaining({ singletonKey: 'job-2', startAfter: 60 }),
    );
  });

  describe('enqueuePmJob', () => {
    it('routes to the PM queue, never the coder queue', async () => {
      await enqueuePmJob('pm-1');
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(
        PM_QUEUE_NAME,
        { jobId: 'pm-1' },
        expect.objectContaining({ singletonKey: 'pm-1' }),
      );
      // Defensive: ensure it never accidentally posts to the coder queue.
      const calls = sendMock.mock.calls.map((c) => c[0]);
      expect(calls).not.toContain(JOB_QUEUE_NAME);
    });

    it('passes startAfter when provided', async () => {
      await enqueuePmJob('pm-2', { startAfterSeconds: 30 });
      expect(sendMock).toHaveBeenCalledWith(
        PM_QUEUE_NAME,
        { jobId: 'pm-2' },
        expect.objectContaining({ singletonKey: 'pm-2', startAfter: 30 }),
      );
    });
  });

  describe('createPmJob', () => {
    function mockInsertOnce(row: { id: string } | null): void {
      insertMock.mockImplementationOnce(() => ({
        values: () => ({
          returning: async () => (row ? [row] : []),
        }),
      }));
    }

    function mockInsertThrows(err: unknown): void {
      insertMock.mockImplementationOnce(() => ({
        values: () => ({
          returning: async () => {
            throw err;
          },
        }),
      }));
    }

    it('inserts a pm job and enqueues it on the PM queue', async () => {
      mockInsertOnce({ id: 'pm-job-1' });
      const result = await createPmJob({ projectId: 'proj-1', createdBy: 'user-1' });
      expect(result).toEqual({ jobId: 'pm-job-1', deduped: false });
      expect(sendMock).toHaveBeenCalledWith(
        PM_QUEUE_NAME,
        { jobId: 'pm-job-1' },
        expect.objectContaining({ singletonKey: 'pm-job-1' }),
      );
    });

    it('treats a 23505 unique-violation as dedup, not error', async () => {
      mockInsertThrows({ code: '23505', message: 'duplicate key' });
      const result = await createPmJob({ projectId: 'proj-1', createdBy: 'user-1' });
      expect(result).toEqual({ deduped: true });
      // Must not enqueue on dedup — there's already an in-flight pm job.
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('rethrows non-unique-violation errors', async () => {
      const boom = new Error('connection refused');
      mockInsertThrows(boom);
      await expect(createPmJob({ projectId: 'proj-1', createdBy: 'user-1' })).rejects.toThrow(
        'connection refused',
      );
      expect(sendMock).not.toHaveBeenCalled();
    });
  });
});
