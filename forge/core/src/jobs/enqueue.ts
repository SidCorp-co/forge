import { boss } from '../queue/boss.js';
import { JOB_QUEUE_NAME } from './queue-name.js';

export interface EnqueueOptions {
  startAfterSeconds?: number;
}

export async function enqueueJob(jobId: string, opts: EnqueueOptions = {}): Promise<void> {
  await boss.send(
    JOB_QUEUE_NAME,
    { jobId },
    {
      singletonKey: jobId,
      ...(opts.startAfterSeconds !== undefined ? { startAfter: opts.startAfterSeconds } : {}),
    },
  );
}
