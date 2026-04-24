import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn(async () => 'msg-1');

vi.mock('../queue/boss.js', () => ({
  boss: { send: sendMock },
}));

const { enqueueJob } = await import('./enqueue.js');
const { JOB_QUEUE_NAME } = await import('./queue-name.js');

describe('jobs/enqueue', () => {
  beforeEach(() => {
    sendMock.mockClear();
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
});
