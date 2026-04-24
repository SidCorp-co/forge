import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, jobs } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { getActiveDeviceId } from './active-device.js';
import { JOB_QUEUE_NAME } from './queue-name.js';

interface DispatchMessage {
  jobId: string;
}

let workerId: string | null = null;

export async function handleDispatch(msg: DispatchMessage): Promise<'dispatched' | 'skipped'> {
  const { jobId } = msg;

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) {
    logger.warn({ jobId }, 'dispatcher: job not found');
    return 'skipped';
  }
  if (job.status !== 'queued') {
    logger.debug({ jobId, status: job.status }, 'dispatcher: non-queued job, skipping');
    return 'skipped';
  }

  const deviceId = await getActiveDeviceId(job.projectId);
  if (!deviceId) {
    logger.warn(
      { jobId, projectId: job.projectId },
      'dispatcher: no active device, leaving queued',
    );
    return 'skipped';
  }

  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) {
    logger.warn({ jobId, deviceId }, 'dispatcher: active device not found, leaving queued');
    return 'skipped';
  }
  if (device.status !== 'online') {
    logger.warn(
      { jobId, deviceId, status: device.status },
      'dispatcher: device offline, leaving queued',
    );
    return 'skipped';
  }

  // Atomic transition; the where-clause wins races with concurrent dispatchers.
  const dispatchedAt = new Date();
  const updated = await db
    .update(jobs)
    .set({ status: 'dispatched', deviceId, dispatchedAt })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });

  if (updated.length === 0) {
    logger.debug({ jobId }, 'dispatcher: lost race to another dispatcher');
    return 'skipped';
  }

  // F2: push `job.assigned` to the device's room so the device-runner can spawn Claude.
  roomManager.publish(deviceRoom(deviceId), {
    event: 'job.assigned',
    data: {
      jobId: job.id,
      projectId: job.projectId,
      type: job.type,
      payload: job.payload,
      dispatchedAt: dispatchedAt.toISOString(),
    },
  });

  logger.info({ jobId, deviceId }, 'dispatcher: dispatched');
  return 'dispatched';
}

export async function registerDispatcher(): Promise<void> {
  if (workerId) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions; the runtime contract (handler receives an array) is stable.
  const id = (await (boss as any).work(JOB_QUEUE_NAME, { batchSize: 1 }, async (arg: any) => {
    const entries = Array.isArray(arg) ? arg : [arg];
    for (const entry of entries) {
      const data = entry?.data as DispatchMessage | undefined;
      if (!data || typeof data.jobId !== 'string') continue;
      try {
        await handleDispatch(data);
      } catch (err) {
        logger.error({ err, jobId: data.jobId }, 'dispatcher: handler threw');
        throw err;
      }
    }
  })) as string;
  workerId = id;
}

export async function unregisterDispatcher(): Promise<void> {
  if (!workerId) return;
  const id = workerId;
  workerId = null;
  // biome-ignore lint/suspicious/noExplicitAny: see registerDispatcher above.
  await (boss as any).offWork(id);
}

export function isDispatcherRegistered(): boolean {
  return workerId !== null;
}
