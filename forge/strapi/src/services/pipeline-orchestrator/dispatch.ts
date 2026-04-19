/**
 * Pipeline queue: session creation, dispatch, and promotion.
 */

import {
  SESSION_UID,
  MAX_FRESH_RETRIES,
  findResumableSession,
  countFailedFreshSessions,
  postPipelineComment,
  isPipelinePaused,
  hasRunningSessionForIssue,
} from '../pipeline-utils';
import { resumeDesktopSession, runViaDesktop, runViaAntigravity } from '../pipeline-runners';
import { resolveRepoPath } from '../resolve-repo-path';
import { findAvailableDevice, clearDeviceAllocation, isDeviceBusy } from '../device-pool';
import { isDeviceConnected } from '../websocket';
import type { PipelineConfig } from '../pipeline-antigravity';
import { DEDUP_WINDOW_MS } from './config';

// Per project+runner lock prevents race conditions when multiple pipeline
// steps trigger concurrently (e.g. bulk status change).
const dispatchLocks = new Map<string, Promise<any>>();

export function withLock<T>(locks: Map<string, Promise<any>>, key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next);
  next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
  return next;
}

// Per-issue lock prevents concurrent onStatusChange calls from both
// passing the dedup check before either creates a session.
export const statusChangeLocks = new Map<string, Promise<any>>();

/**
 * Dispatch queued sessions for a project+runner combination.
 * Promotes as many queued sessions as there are free devices/runners.
 */
export async function dispatchNextForProject(
  strapi: any,
  projectDocumentId: string,
  runner: 'desktop' | 'antigravity',
): Promise<void> {
  const lockKey = `${projectDocumentId}:${runner}`;

  await withLock(dispatchLocks, lockKey, async () => {
    if (isPipelinePaused()) {
      strapi.log.debug(`[pipeline] Pipeline paused, not dispatching for ${projectDocumentId}:${runner}`);
      return;
    }

    const allQueued = await strapi.documents(SESSION_UID).findMany({
      filters: {
        project: { documentId: { $eq: projectDocumentId } },
        status: 'queued',
      },
      sort: 'createdAt:asc',
      populate: ['issues', 'project', 'project.defaultDevice'],
      limit: 50,
    });
    const queuedSessions = allQueued.filter(
      (s: any) => s.metadata?.type === 'pipeline' && s.metadata?.runner === runner,
    );
    if (queuedSessions.length === 0) {
      strapi.log.debug(`[pipeline] dispatchNext ${runner}: 0 queued (${allQueued.length} total) for ${projectDocumentId.slice(0, 8)}`);
      return;
    }

    strapi.log.info(`[pipeline] dispatchNext ${runner}: ${queuedSessions.length} queued for ${projectDocumentId.slice(0, 8)}`);
    for (const queued of queuedSessions) {
      try {
        await promoteQueuedSession(strapi, queued);
      } catch (err: any) {
        strapi.log.error(
          `[pipeline] promoteQueuedSession failed for ${queued.documentId} (ISS-${queued.issues?.[0]?.id}): ${err.message}`,
        );
      }
    }
  });
}

/**
 * Create a queued session in the DB. Visible in UI, can be cancelled.
 */
export async function createQueuedSession(
  strapi: any,
  issue: any,
  skillDef: { skill: string; prompt: (issue: any) => string },
  fromStatus: string,
  toStatus: string,
  stepConfig: { runner: string; model?: string },
  manual = false,
  sessionOptions?: { origin?: string },
): Promise<string> {
  const prompt = skillDef.prompt(issue);

  // Deduplicate: skip if the same issue+status is already queued
  const existing = await strapi.documents(SESSION_UID).findMany({
    filters: {
      issues: { documentId: { $eq: issue.documentId } },
      status: 'queued',
    },
    limit: 5,
  });
  const dup = existing.find(
    (s: any) => s.metadata?.type === 'pipeline' && s.metadata?.toStatus === toStatus,
  );
  if (dup) {
    strapi.log.debug(`[pipeline] ISS-${issue.id}: already queued for ${toStatus}, skipping`);
    return dup.documentId;
  }

  const session = await strapi.documents(SESSION_UID).create({
    data: {
      title: `${skillDef.skill}: ISS-${issue.id} ${issue.title}`.slice(0, 120),
      status: 'queued',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      project: issue.project.documentId,
      issues: [issue.documentId],
      metadata: {
        type: 'pipeline',
        skill: skillDef.skill,
        fromStatus,
        toStatus,
        runner: stepConfig.runner,
        model: stepConfig.model || undefined,
        ...(manual ? { manual: true } : {}),
        ...(sessionOptions?.origin ? { origin: sessionOptions.origin } : {}),
      },
    },
  });
  return session.documentId;
}

/**
 * Promote a queued session directly to running and dispatch it.
 */
export async function promoteQueuedSession(strapi: any, queued: any): Promise<void> {
  const meta = queued.metadata || {};
  const issueDocId = queued.issues?.[0]?.documentId;
  if (!issueDocId) {
    await strapi.documents(SESSION_UID).update({ documentId: queued.documentId, data: { status: 'failed' } });
    return;
  }

  const issue = await strapi.documents('api::issue.issue').findOne({
    documentId: issueDocId,
    populate: ['project', 'project.defaultDevice'],
  });
  if (!issue?.project) {
    strapi.log.warn(`[pipeline] Queued session ${queued.documentId}: issue ${issueDocId} not found, marking failed`);
    await strapi.documents(SESSION_UID).update({ documentId: queued.documentId, data: { status: 'failed' } });
    return;
  }

  // Manual hold: user aborted — cancel queued session instead of promoting
  if (!meta.manual && (issue as any).manualHold) {
    strapi.log.info(`[pipeline] ISS-${issue.id}: manualHold is set, cancelling queued session ${queued.documentId}`);
    await strapi.documents(SESSION_UID).update({ documentId: queued.documentId, data: { status: 'failed', metadata: { ...meta, error: 'Cancelled: issue on manual hold' } } as any });
    return;
  }

  // Cooldown gate: transient errors set a retryAfter timestamp.
  if (meta.retryAfter && Date.now() < new Date(meta.retryAfter).getTime()) {
    const remaining = Math.ceil((new Date(meta.retryAfter).getTime() - Date.now()) / 1000);
    strapi.log.info(
      `[pipeline] ISS-${issue.id}: session ${queued.documentId} cooling down, ${remaining}s remaining`,
    );
    return;
  }

  // Race condition guard
  if (await hasRunningSessionForIssue(strapi, issueDocId, queued.documentId)) {
    strapi.log.info(
      `[pipeline] ISS-${issue.id}: another session still running for this issue, staying queued`,
    );
    return;
  }

  // Dedup guard
  if (meta.toStatus) {
    const recentSessions = await strapi.documents(SESSION_UID).findMany({
      filters: {
        issues: { documentId: { $eq: issueDocId } },
        createdAt: { $gte: new Date(Date.now() - DEDUP_WINDOW_MS).toISOString() },
      },
      limit: 10,
    });
    const alreadyHandled = recentSessions.find(
      (s: any) => s.documentId !== queued.documentId
        && s.metadata?.type === 'pipeline'
        && s.metadata?.toStatus === meta.toStatus
        && (s.status === 'running' || s.status === 'completed'),
    );
    if (alreadyHandled) {
      strapi.log.info(
        `[pipeline] ISS-${issue.id}: duplicate — ${meta.skill} already ${alreadyHandled.status} (${alreadyHandled.documentId}), cancelling queued ${queued.documentId}`,
      );
      await strapi.documents(SESSION_UID).delete({ documentId: queued.documentId });
      return;
    }
  }

  const runner = meta.runner || 'desktop';
  const prompt = queued.messages?.[0]?.content || '';

  strapi.log.info(
    `[pipeline] Promoting queued session ${queued.documentId}: ${meta.skill} for ISS-${issue.id} via ${runner}`,
  );

  // Desktop runner
  if (runner === 'desktop') {
    const existingSession = await findResumableSession(strapi, issueDocId);
    if (existingSession) {
      const resumeDeviceId: string | null = existingSession.metadata?.deviceId || issue.project.defaultDevice?.deviceId || null;
      const resumeDeviceName: string | null = existingSession.metadata?.deviceName || issue.project.defaultDevice?.name || null;

      if (resumeDeviceId && !isDeviceConnected(resumeDeviceId)) {
        strapi.log.info(
          `[pipeline] ISS-${issue.id}: resumable session ${existingSession.documentId} exists on device ${resumeDeviceId} but device is disconnected, starting fresh`,
        );
      } else if (resumeDeviceId && await isDeviceBusy(issue.project.documentId, resumeDeviceId)) {
        strapi.log.info(
          `[pipeline] ISS-${issue.id}: resumable session ${existingSession.documentId} exists on device ${resumeDeviceId} but device is busy, staying queued`,
        );
        return;
      } else {
        const isRetry = existingSession.status === 'failed';
        const retryCount = (existingSession.metadata?.retryCount || 0) + (isRetry ? 1 : 0);

        strapi.log.info(
          `[pipeline] ISS-${issue.id}: ${isRetry ? `retrying (${retryCount}/5)` : 'resuming'} session ${existingSession.documentId} on device ${resumeDeviceId || 'NONE'} (claude=${existingSession.claudeSessionId}, ctx=${existingSession.usage?.contextUsed || 0})`,
        );

        await strapi.documents(SESSION_UID).delete({ documentId: queued.documentId });
        await resumeDesktopSession(strapi, existingSession, issue, prompt, meta.skill, meta.fromStatus, meta.toStatus, retryCount, resumeDeviceName);
        return;
      }
    }

    // Fresh start — check retry limit
    const freshFailures = meta.manual ? 0 : await countFailedFreshSessions(strapi, issueDocId, meta.skill);
    if (freshFailures >= MAX_FRESH_RETRIES) {
      strapi.log.warn(
        `[pipeline] ISS-${issue.id}: ${meta.skill} failed ${freshFailures} fresh sessions, stopping pipeline`,
      );
      await strapi.documents(SESSION_UID).update({
        documentId: queued.documentId,
        data: { status: 'failed', metadata: { ...meta, error: `Pipeline stopped: ${freshFailures} fresh attempts failed` } } as any,
      });
      const currentIssue = await strapi.documents('api::issue.issue').findOne({ documentId: issue.documentId, fields: ['manualHold'] });
      if (!currentIssue?.manualHold) {
        await postPipelineComment(strapi, issue.documentId, `Pipeline stopped for **${meta.skill}**: failed ${freshFailures} fresh session attempts (resume retries also exhausted). Setting \`manualHold\` for manual intervention.`, 'pipeline');
        await strapi.documents('api::issue.issue').update({ documentId: issue.documentId, data: { manualHold: true } });
      }
      return;
    }

    const allocated = await findAvailableDevice(issue.project.documentId);
    if (!allocated) {
      strapi.log.info(
        `[pipeline] ISS-${issue.id}: no available desktop device for project ${issue.project.documentId.slice(0, 8)}, staying queued`,
      );
      return;
    }
    const deviceId = allocated.deviceId;
    const deviceName = allocated.deviceName;
    clearDeviceAllocation(allocated.deviceId);

    const rp = await resolveRepoPath(strapi, issue.project.slug, deviceId, undefined, issue.project.repoPath);
    const desktopMeta = { ...meta, deviceId: deviceId || undefined, deviceName: deviceName || undefined };
    await strapi.documents(SESSION_UID).update({
      documentId: queued.documentId,
      data: {
        status: 'running',
        repoPath: rp,
        metadata: desktopMeta,
      } as any,
    });
    queued.metadata = desktopMeta;

    await runViaDesktop(strapi, queued, issue, prompt, deviceId, meta.skill);
    return;
  }

  // Antigravity runner
  if (runner === 'antigravity') {
    if (!meta.manual) {
      const { checkAntigravityReady, pauseProjectAntigravity } = await import('../antigravity-runner-pool');
      const readiness = await checkAntigravityReady(issue.project.documentId);
      if (!readiness.ready) {
        strapi.log.info(
          `[pipeline] ISS-${issue.id}: Antigravity not ready, staying queued — ${readiness.error}`,
        );
        await pauseProjectAntigravity(issue.project.documentId, readiness.error!);
        return;
      }
    }

    let allocation: any;
    try {
      const projectMap: Record<string, string> = (issue.project as any).antigravityProjectMap || {};
      const freshFailures = meta.manual ? 0 : await countFailedFreshSessions(strapi, issueDocId, meta.skill, projectMap);
      if (freshFailures >= MAX_FRESH_RETRIES) {
        strapi.log.warn(
          `[pipeline] ISS-${issue.id}: ${meta.skill} failed ${freshFailures} fresh sessions, stopping pipeline`,
        );
        await strapi.documents(SESSION_UID).update({
          documentId: queued.documentId,
          data: { status: 'failed', metadata: { ...meta, error: `Pipeline stopped: ${freshFailures} fresh attempts failed` } } as any,
        });
        const currentIssue = await strapi.documents('api::issue.issue').findOne({ documentId: issue.documentId, fields: ['manualHold'] });
        if (!currentIssue?.manualHold) {
          await postPipelineComment(strapi, issue.documentId, `Pipeline stopped for **${meta.skill}**: failed ${freshFailures} fresh session attempts. Setting \`manualHold\` for manual intervention.`, 'pipeline');
          await strapi.documents('api::issue.issue').update({ documentId: issue.documentId, data: { manualHold: true } });
        }
        return;
      }

      const { findAvailableRunner, clearRunnerAllocation } = await import('../antigravity-runner-pool');
      allocation = await findAvailableRunner(issue.project.documentId);
      if (!allocation) {
        strapi.log.info(
          `[pipeline] ISS-${issue.id}: all antigravity runners busy, staying queued`,
        );
        return;
      }

      const runnerMeta = {
        ...meta,
        antigravityRunnerId: allocation.runnerId,
        antigravityRunnerName: allocation.runnerName,
        antigravityRunnerAgentId: allocation.agentId,
        antigravityProjectId: allocation.antigravityProjectId,
      };

      await strapi.documents(SESSION_UID).update({
        documentId: queued.documentId,
        data: { status: 'running', metadata: runnerMeta } as any,
      });
      queued.metadata = runnerMeta;

      if (allocation.runnerId !== '__legacy__') {
        clearRunnerAllocation(allocation.runnerId);
      }
    } catch (err: any) {
      strapi.log.error(
        `[pipeline] ISS-${issue.id}: Antigravity dispatch error: ${err.message}`,
      );
      return;
    }

    const pipelineConfig = issue.project.agentConfig?.pipelineConfig || { enabled: false };
    runViaAntigravity(strapi, queued, issue, prompt, pipelineConfig, { model: meta.model }, meta.skill).catch(async (err: any) => {
      strapi.log.error(`[pipeline] ISS-${issue.id}: Antigravity error (last-resort): ${err.message}`);
      try {
        const current = await strapi.documents(SESSION_UID).findOne({ documentId: queued.documentId, populate: ['issues'] });
        if (current?.status === 'running') {
          const quotaPattern = /quota.*exhaust|token limit.*reached|credit.*exhaust|out of.*quota|billing.*limit|exceeded.*quota|quota.*exceeded|model quota reached/i;
          if (quotaPattern.test(err.message)) {
            await strapi.documents(SESSION_UID).update({
              documentId: queued.documentId,
              data: { status: 'queued' } as any,
            });
            strapi.log.warn(`[pipeline] ISS-${issue.id}: Quota error in last-resort catch, re-queued session`);
          } else {
            const { recoverOrFailSession } = await import('../pipeline-utils');
            await recoverOrFailSession(strapi, current, err.message, { tag: 'orchestrator-catch' });
          }
          await dispatchNextForProject(strapi, issue.project.documentId, 'antigravity');
        }
      } catch (cleanupErr: any) {
        strapi.log.error(`[pipeline] ISS-${issue.id}: cleanup after Antigravity error also failed: ${cleanupErr.message}`);
      }
    });
    return;
  }

  strapi.log.warn(
    `[pipeline] ISS-${issue.id}: session ${queued.documentId} fell through without dispatching (runner=${runner})`,
  );
}
