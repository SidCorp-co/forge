import type { Core } from '@strapi/strapi';
import { sendToDevice, isDeviceConnected } from './websocket';
import { findAvailableDevice, clearDeviceAllocation } from './device-pool';
import { resolveRepoPath } from './resolve-repo-path';

const SCHEDULE_UID = 'api::schedule.schedule' as any;
const SESSION_UID = 'api::agent-session.agent-session' as any;
const PROJECT_UID = 'api::project.project' as any;

function computeNextRunAt(cron: string): string | null {
  try {
    const cronParser = require('cron-parser');
    const interval = cronParser.parseExpression(cron);
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

/**
 * Dispatch a single schedule: create an agent session and send to the appropriate runner.
 * Returns the session documentId or throws on failure.
 */
export async function dispatchSchedule(strapi: Core.Strapi, schedule: any): Promise<string> {
  const project = schedule.project;
  if (!project) throw new Error('Schedule has no project');

  // Resolve target project if cross-project
  let targetProject = project;
  if (schedule.targetProjectSlug) {
    const target = await strapi.documents(PROJECT_UID).findFirst({
      filters: { slug: { $eq: schedule.targetProjectSlug } },
      populate: ['defaultDevice'],
    });
    if (target) targetProject = target;
  }

  const targetProjectDocId = targetProject.documentId || targetProject;

  const runner = schedule.runner || 'antigravity';

  if (runner === 'desktop') {
    // Desktop dispatch — find available device
    const allocated = await findAvailableDevice(targetProjectDocId);
    if (allocated) clearDeviceAllocation(allocated.deviceId);
    let deviceId: string | null = allocated?.deviceId ?? null;
    if (!deviceId) {
      // Fall back to project's defaultDevice
      const proj = await strapi.documents(PROJECT_UID).findOne({
        documentId: targetProjectDocId,
        populate: ['defaultDevice'],
      });
      deviceId = (proj as any)?.defaultDevice?.deviceId || null;
    }
    if (!deviceId || !isDeviceConnected(deviceId)) {
      // Mark skipped — no device
      await strapi.documents(SCHEDULE_UID).update({
        documentId: schedule.documentId,
        data: { lastStatus: 'skipped', lastRunAt: new Date().toISOString(), nextRunAt: computeNextRunAt(schedule.cron) } as any,
      });
      throw new Error('No desktop device connected');
    }

    const rp = await resolveRepoPath(strapi, targetProject.slug || '', deviceId, undefined, targetProject.repoPath);
    const session = await strapi.documents(SESSION_UID).create({
      data: {
        title: `${schedule.name} (Scheduled)`,
        status: 'running',
        messages: [{ role: 'user', content: schedule.prompt, timestamp: Date.now() }],
        project: targetProjectDocId,
        repoPath: rp,
        metadata: { type: 'schedule', scheduleId: schedule.documentId, scheduled: true },
      } as any,
    });

    sendToDevice(deviceId, 'agent:start', {
      sessionId: session.documentId,
      repoPath: rp,
      projectSlug: targetProject.slug || '',
      prompt: schedule.prompt,
    });

    await strapi.documents(SCHEDULE_UID).update({
      documentId: schedule.documentId,
      data: {
        lastStatus: 'running',
        lastRunAt: new Date().toISOString(),
        lastSessionId: session.documentId,
        nextRunAt: computeNextRunAt(schedule.cron),
      } as any,
    });

    return session.documentId;
  }

  // Antigravity dispatch
  try {
    const { findAvailableRunner, clearRunnerAllocation } = require('./antigravity-runner-pool');
    const agRunner = await findAvailableRunner(targetProjectDocId);
    if (!agRunner) {
      await strapi.documents(SCHEDULE_UID).update({
        documentId: schedule.documentId,
        data: { lastStatus: 'skipped', lastRunAt: new Date().toISOString(), nextRunAt: computeNextRunAt(schedule.cron) } as any,
      });
      throw new Error('No antigravity runner available');
    }
    clearRunnerAllocation(agRunner.runnerId);

    const { chatAsync } = require('./antigravity');
    const session = await strapi.documents(SESSION_UID).create({
      data: {
        title: `${schedule.name} (Scheduled)`,
        status: 'running',
        messages: [{ role: 'user', content: schedule.prompt, timestamp: Date.now() }],
        project: targetProjectDocId,
        metadata: {
          type: 'schedule',
          scheduleId: schedule.documentId,
          scheduled: true,
          runnerId: agRunner.runnerId,
          antigravityProjectId: agRunner.antigravityProjectId,
        },
      } as any,
    });

    // Fire async chat — don't await completion
    chatAsync({
      projectId: agRunner.antigravityProjectId,
      message: schedule.prompt,
      newSession: true,
    }).catch((err: any) => {
      strapi.log.error(`Schedule ${schedule.name} antigravity dispatch error: ${err.message}`);
    });

    await strapi.documents(SCHEDULE_UID).update({
      documentId: schedule.documentId,
      data: {
        lastStatus: 'running',
        lastRunAt: new Date().toISOString(),
        lastSessionId: session.documentId,
        nextRunAt: computeNextRunAt(schedule.cron),
      } as any,
    });

    return session.documentId;
  } catch (err: any) {
    if (err.message === 'No antigravity runner available') throw err;
    await strapi.documents(SCHEDULE_UID).update({
      documentId: schedule.documentId,
      data: { lastStatus: 'failed', lastRunAt: new Date().toISOString(), nextRunAt: computeNextRunAt(schedule.cron) } as any,
    });
    throw err;
  }
}

/**
 * Main cron entry point — find all due schedules and dispatch them.
 */
export async function executeScheduledJobs(strapi: Core.Strapi) {
  const now = new Date().toISOString();

  const dueSchedules = await strapi.documents(SCHEDULE_UID).findMany({
    filters: {
      enabled: { $eq: true },
      nextRunAt: { $lte: now, $notNull: true },
    },
    populate: ['project'],
    limit: 50,
  });

  for (const schedule of dueSchedules) {
    // Skip if already running (overlapping run guard)
    if ((schedule as any).lastStatus === 'running') {
      // Check if last session is still active
      const lastSessionId = (schedule as any).lastSessionId;
      if (lastSessionId) {
        const session = await strapi.documents(SESSION_UID).findOne({
          documentId: lastSessionId,
          fields: ['status'],
        });
        if (session && ['running', 'queued'].includes((session as any).status)) {
          continue; // Still running, skip
        }
      }
    }

    try {
      await dispatchSchedule(strapi, schedule);
      strapi.log.info(`Schedule "${(schedule as any).name}" dispatched`);
    } catch (err: any) {
      strapi.log.warn(`Schedule "${(schedule as any).name}" failed: ${err.message}`);
    }
  }
}
