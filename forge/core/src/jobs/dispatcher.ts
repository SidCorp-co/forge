import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, jobs, projects, runners } from '../db/schema.js';
import { isEnabled } from '../lib/feature-flags.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { getRunnerAdapter } from '../runners/registry.js';
import { selectRunnerForJob } from '../runners/select.js';
import type { RequiredCapabilities } from '../runners/types.js';
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

  if (isEnabled('runnerFramework')) {
    return dispatchViaRunner(job);
  }
  return dispatchViaDevice(job);
}

async function dispatchViaDevice(job: typeof jobs.$inferSelect): Promise<'dispatched' | 'skipped'> {
  const deviceId = await getActiveDeviceId(job.projectId);
  if (!deviceId) {
    logger.warn(
      { jobId: job.id, projectId: job.projectId },
      'dispatcher: no active device, leaving queued',
    );
    return 'skipped';
  }

  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) {
    logger.warn({ jobId: job.id, deviceId }, 'dispatcher: active device not found, leaving queued');
    return 'skipped';
  }
  if (device.status !== 'online') {
    logger.warn(
      { jobId: job.id, deviceId, status: device.status },
      'dispatcher: device offline, leaving queued',
    );
    return 'skipped';
  }

  const dispatchedAt = new Date();
  const updated = await db
    .update(jobs)
    .set({ status: 'dispatched', deviceId, dispatchedAt })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });

  if (updated.length === 0) {
    logger.debug({ jobId: job.id }, 'dispatcher: lost race to another dispatcher');
    return 'skipped';
  }

  roomManager.publish(deviceRoom(deviceId), {
    event: 'job.assigned',
    data: {
      jobId: job.id,
      projectId: job.projectId,
      issueId: job.issueId,
      type: job.type,
      payload: job.payload,
      dispatchedAt: dispatchedAt.toISOString(),
    },
  });

  logger.info({ jobId: job.id, deviceId }, 'dispatcher: dispatched (legacy device path)');
  return 'dispatched';
}

async function dispatchViaRunner(job: typeof jobs.$inferSelect): Promise<'dispatched' | 'skipped'> {
  const payload = (job.payload ?? {}) as { requiredCapabilities?: RequiredCapabilities };
  const required = payload.requiredCapabilities ?? {};

  const [project] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, job.projectId))
    .limit(1);
  const agentConfig = (project?.agentConfig ?? {}) as { runnerFallback?: string[] };
  const fallbackChain = (agentConfig.runnerFallback ?? ['claude-code']) as Array<
    'claude-code' | 'antigravity'
  >;

  const runner = await selectRunnerForJob({
    projectId: job.projectId,
    requiredCapabilities: required,
    fallbackChain,
  });
  if (!runner) {
    logger.warn(
      { jobId: job.id, projectId: job.projectId, fallbackChain },
      'dispatcher: no runner online, leaving queued',
    );
    return 'skipped';
  }

  const adapter = getRunnerAdapter(runner.type);
  if (!adapter) {
    logger.error(
      { jobId: job.id, runnerId: runner.id, type: runner.type },
      'dispatcher: runner has no registered adapter, leaving queued',
    );
    return 'skipped';
  }

  const dispatchedAt = new Date();
  const updated = await db
    .update(jobs)
    .set({
      status: 'dispatched',
      runnerId: runner.id,
      // Mirror to deviceId for backwards-compat with consumers reading the
      // legacy column. Antigravity-remote runners have deviceId=null so this
      // remains null in that case.
      deviceId: runner.deviceId,
      dispatchedAt,
    })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });

  if (updated.length === 0) {
    logger.debug({ jobId: job.id }, 'dispatcher: lost race to another dispatcher');
    return 'skipped';
  }

  const result = await adapter.dispatch({
    job: {
      id: job.id,
      projectId: job.projectId,
      issueId: job.issueId,
      type: job.type,
      payload: job.payload,
      dispatchedAt,
    },
    runner,
  });

  if (result.status === 'failed') {
    // Revert: put the job back on the queue so retry/stale logic can act.
    // Conditional WHERE prevents stomping on a concurrent lifecycle update
    // (e.g. /jobs/:id/complete fired in the meantime). Use SQL `attempts + 1`
    // so the increment is computed against the current row, not the stale read.
    await db
      .update(jobs)
      .set({
        status: 'queued',
        runnerId: null,
        deviceId: null,
        dispatchedAt: null,
        error: result.errorReason ?? 'adapter dispatch failed',
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(
        and(eq(jobs.id, job.id), eq(jobs.status, 'dispatched'), eq(jobs.runnerId, runner.id)),
      );
    // Also flag the runner as last-error for surface visibility.
    await db
      .update(runners)
      .set({ lastError: result.errorReason ?? 'dispatch failed', updatedAt: new Date() })
      .where(eq(runners.id, runner.id));
    logger.warn(
      { jobId: job.id, runnerId: runner.id, reason: result.errorReason },
      'dispatcher: adapter failed, requeued',
    );
    return 'skipped';
  }

  logger.info(
    { jobId: job.id, runnerId: runner.id, type: runner.type },
    'dispatcher: dispatched (runner path)',
  );
  return 'dispatched';
}

export async function registerDispatcher(): Promise<void> {
  if (workerId) return;
  // pg-boss v10 requires explicit createQueue before work().
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(JOB_QUEUE_NAME);
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
