/**
 * Session lifecycle: recovery, failure handling, stale session watcher.
 */

import { broadcast } from '../websocket';
import {
  SESSION_UID, ISSUE_UID, pipelineTelemetry, MAX_FRESH_RETRIES,
  SKILL_EXPECTED_STATUSES, OVERLOAD_COOLDOWN_MS,
} from './constants';
import {
  isProjectLevelError, isDeviceEnvironmentError, isUsageLimitError,
  isTransientOverloadError, isSessionNotFoundError, isApiServerError,
  API_SERVER_ERROR_DISABLE_MS, handleUsageLimitIfPresent, disableDeviceUntil,
} from './error-classification';
import { countFailedFreshSessions } from './session-queries';
import { postPipelineComment } from './comments';
import { dispatchAllQueued } from './control';

/**
 * On server startup, recover running antigravity sessions and dispatch queued ones.
 * Running antigravity sessions may have completed while the server was down —
 * poll their requestId to check before marking them failed.
 */
export async function cleanupStaleSessions(strapi: any): Promise<void> {
  try {
    // 1. Recover running sessions — check if they completed or their device disconnected
    await recoverRunningSessions(strapi);

    // 2. Dispatch queued pipeline sessions blocked by sessions that completed while server was down.
    await dispatchAllQueued(strapi, 'pipeline-boot');
  } catch (err: any) {
    strapi.log.warn(`[pipeline] Boot cleanup failed: ${err.message}`);
  }
}

/**
 * On boot, find running pipeline sessions and recover them:
 *
 * Antigravity sessions: poll their requestId to check actual status.
 * Desktop sessions: check if the device is still connected — if not,
 * the session can never complete and should be marked failed.
 *
 * This prevents "zombie" running sessions from blocking the queue indefinitely.
 */
async function recoverRunningSessions(strapi: any): Promise<void> {
  const runningSessions = await strapi.documents(SESSION_UID).findMany({
    filters: { status: 'running' },
    populate: ['issues', 'project'],
    limit: 50,
  });

  // Include both pipeline and rest-api antigravity sessions
  const recoverableSessions = runningSessions.filter(
    (s: any) => s.metadata?.type === 'pipeline'
      || (s.metadata?.origin === 'rest-api' && s.metadata?.runner === 'antigravity'),
  );

  if (!recoverableSessions.length) return;

  const antigravitySessions = recoverableSessions.filter((s: any) => s.metadata?.runner === 'antigravity');
  const desktopSessions = recoverableSessions.filter((s: any) => s.metadata?.runner !== 'antigravity');

  strapi.log.info(
    `[pipeline] Boot: checking ${recoverableSessions.length} running session(s) (${antigravitySessions.length} antigravity, ${desktopSessions.length} desktop)`,
  );

  // ── Recover Antigravity sessions ──
  if (antigravitySessions.length) {
    const { chatStatus, parseAntigravityResponse } = await import('../antigravity');

    for (const session of antigravitySessions) {
      // Pipeline sessions use requestId, rest-api sessions use antigravityRequestId
      const requestId = session.metadata?.requestId || session.metadata?.antigravityRequestId;
      const issueId = session.issues?.[0]?.id || '?';

      if (!requestId) {
        const outcome = await recoverOrFailSession(strapi, session,
          'Server restarted before Antigravity requestId was saved',
          { tag: 'boot' },
        );
        strapi.log.info(`[pipeline] Boot: session ${session.documentId} (ISS-${issueId}) no requestId → ${outcome}`);
        continue;
      }

      try {
        const status = await chatStatus(requestId);
        const currentStatus = status.status || 'unknown';

        if (currentStatus === 'Completed') {
          const result = status.result || ({} as any);
          const response = parseAntigravityResponse(result.response || '');

          await strapi.documents(SESSION_UID).update({
            documentId: session.documentId,
            data: {
              status: 'completed',
              messages: [
                ...(session.messages || []),
                { role: 'assistant', content: response, timestamp: Date.now() },
              ],
              metadata: {
                ...session.metadata,
                elapsedSeconds: result.elapsedSeconds,
                recoveredOnBoot: true,
              },
            } as any,
          });

          strapi.log.info(
            `[pipeline] Boot: recovered antigravity session ${session.documentId} (ISS-${issueId}) — completed in ${result.elapsedSeconds}s`,
          );
        } else if (currentStatus === 'Failed') {
          const errorMsg = status.error || 'Antigravity task failed (recovered on boot)';
          const outcome = await recoverOrFailSession(strapi, session, errorMsg, { tag: 'boot' });
          strapi.log.info(`[pipeline] Boot: session ${session.documentId} (ISS-${issueId}) Antigravity failed → ${outcome}`);
        } else {
          // Still Pending or Running — leave as-is, stale watcher will handle if it dies
          strapi.log.info(
            `[pipeline] Boot: antigravity session ${session.documentId} (ISS-${issueId}) still ${currentStatus}, leaving as running`,
          );
        }
      } catch (err: any) {
        strapi.log.warn(
          `[pipeline] Boot: failed to check Antigravity status for session ${session.documentId}: ${err.message}`,
        );
        // Don't mark failed — Antigravity service might just be temporarily unreachable
      }
    }
  }

  // Desktop sessions are NOT recovered at boot — WebSocket connections haven't
  // been re-established yet, so checking isDeviceConnected would prematurely
  // fail sessions for devices that are about to reconnect. The stale watcher
  // (every 2 min, 15 min threshold) handles desktop sessions instead, giving
  // devices time to reconnect after a server restart.
  if (desktopSessions.length) {
    strapi.log.info(
      `[pipeline] Boot: ${desktopSessions.length} desktop session(s) still running — deferring to stale watcher (devices may reconnect)`,
    );
  }
}

/**
 * Mark a session as failed and post failure comments on linked issues.
 * Optionally persists recovery metadata for audit/health queries.
 */
export async function updateSessionFailed(
  strapi: any,
  session: any,
  error: string,
  recoveryMeta?: { recoveryOutcome: string; recoveryTag: string; autoRetried?: boolean; retriesExhausted?: boolean },
) {
  await strapi.documents(SESSION_UID).update({
    documentId: session.documentId,
    data: {
      status: 'failed',
      messages: [
        ...(session.messages || []),
        { role: 'system', content: error, timestamp: Date.now() },
      ],
      ...(recoveryMeta ? {
        metadata: {
          ...session.metadata,
          ...recoveryMeta,
        },
      } : {}),
    } as any,
  });

  // Skip failure comments for transient API errors — device pause is the action,
  // and multiple sessions hitting the same error would spam duplicate comments.
  if (isUsageLimitError(error) || isApiServerError(error)) return;

  const skill = session.metadata?.skill || 'unknown';
  const issueDocIds: string[] = Array.isArray(session.issues)
    ? session.issues.map((i: any) => typeof i === 'string' ? i : i.documentId).filter(Boolean)
    : [];

  await Promise.allSettled(
    issueDocIds.map((docId) =>
      postPipelineComment(strapi, docId,
        `Pipeline step **${skill}** failed: ${error}`,
        'Pikachu',
      ).catch(() => {}),
    ),
  );
}

// ─── Centralized Session Recovery ─────────────────────────────────────────────

/**
 * Mark a session as completed-by-verification.
 * Used when polling/tracking failed but the issue already advanced
 * to an expected outcome status — proving the agent did its job.
 *
 * @param tag — caller tag for logging (e.g. 'watcher', 'boot', 'poll')
 */
async function markSessionCompleted(
  strapi: any,
  session: any,
  tag: string,
): Promise<void> {
  const skill = session.metadata?.skill || 'unknown';
  await strapi.documents(SESSION_UID).update({
    documentId: session.documentId,
    data: {
      status: 'completed',
      messages: [
        ...(session.messages || []),
        {
          role: 'system',
          content: `Session marked completed by verification — agent's work succeeded but tracking lost. (skill=${skill}, recovered by ${tag})`,
          timestamp: Date.now(),
        },
      ],
      metadata: {
        ...session.metadata,
        completedByVerification: true,
        recoveredBy: tag,
      },
    } as any,
  });
}

/**
 * Check if an issue has already advanced past the triggering status,
 * meaning the agent's work succeeded even though the session tracking failed.
 */
async function checkIssueAdvanced(
  strapi: any,
  issueDocumentId: string,
  triggerStatus: string,
  skill: string,
): Promise<'advanced' | 'unchanged'> {
  try {
    const issue = await strapi.documents(ISSUE_UID).findOne({
      documentId: issueDocumentId,
      fields: ['status'],
    });
    if (!issue) return 'unchanged';

    const currentStatus = issue.status;
    if (currentStatus === triggerStatus) return 'unchanged';

    const expected = SKILL_EXPECTED_STATUSES[skill];
    if (!expected) return 'unchanged';

    if (expected.has(currentStatus)) return 'advanced';

    return 'unchanged';
  } catch {
    return 'unchanged';
  }
}

/** Extract the first issue documentId from a session (handles populated or raw). */
function resolveIssueDocId(session: any): string | undefined {
  const issues = session.issues;
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const first = issues[0];
  return typeof first === 'string' ? first : first?.documentId;
}

/**
 * Centralized session recovery: verify whether the agent's work succeeded
 * (by checking issue status), then either mark completed or mark failed.
 *
 * Returns the outcome so callers can decide next steps (dispatch, retry, etc.).
 *
 * Outcomes:
 * - 'recovered' — issue advanced to expected outcome, session marked completed
 * - 'failed'    — issue unchanged (or at in_progress), session marked failed
 *
 * When outcome is 'failed' and autoRetry is true, requeues the pipeline step
 * if the issue hasn't reached an outcome status yet. This covers the case where
 * the agent set in_progress but died before setting the final status.
 * (guarded by MAX_FRESH_RETRIES + dedup window in onStatusChange).
 *
 * @param tag — caller identifier for logging
 */
export async function recoverOrFailSession(
  strapi: any,
  session: any,
  error: string,
  opts: { tag: string; autoRetry?: boolean },
): Promise<'recovered' | 'failed'> {
  const issueDocId = resolveIssueDocId(session);
  const triggerStatus = session.metadata?.toStatus || '';
  const skill = session.metadata?.skill || '';
  const tag = opts.tag;

  // If we have enough metadata, check if the agent already succeeded
  if (issueDocId && triggerStatus && skill) {
    const advancement = await checkIssueAdvanced(strapi, issueDocId, triggerStatus, skill);

    if (advancement === 'advanced') {
      strapi.log.info(
        `[pipeline:${tag}] Session ${session.documentId}: ${error} — but issue already advanced, marking completed`,
      );
      await markSessionCompleted(strapi, session, tag);

      // Telemetry + WS broadcast
      pipelineTelemetry.recovered++;
      pipelineTelemetry.recoveredBy[tag] = (pipelineTelemetry.recoveredBy[tag] || 0) + 1;
      broadcast('pipeline:recovery', {
        sessionId: session.documentId,
        issueId: session.issues?.[0]?.id || null,
        skill,
        outcome: 'recovered',
        tag,
        error,
      });

      return 'recovered';
    }

    // Issue hasn't reached an outcome status — real failure. Mark session failed with recovery metadata.
    await updateSessionFailed(strapi, session, error, {
      recoveryOutcome: 'failed',
      recoveryTag: tag,
    });

    // Telemetry + WS broadcast
    pipelineTelemetry.failed++;
    broadcast('pipeline:recovery', {
      sessionId: session.documentId,
      issueId: session.issues?.[0]?.id || null,
      skill,
      outcome: 'failed',
      tag,
      error,
    });

    // Detect project-level antigravity errors and cascade-pause the project.
    if (session.metadata?.runner === 'antigravity' && isProjectLevelError(error)) {
      let projectDoc = session.project?.documentId || session.project;
      if (!projectDoc && issueDocId) {
        const issue = await strapi.documents(ISSUE_UID).findOne({ documentId: issueDocId, populate: ['project'] });
        projectDoc = issue?.project?.documentId;
      }
      if (projectDoc) {
        try {
          const { pauseProjectAntigravity } = await import('../antigravity-runner-pool');
          await pauseProjectAntigravity(typeof projectDoc === 'string' ? projectDoc : projectDoc, error);
        } catch (pauseErr: any) {
          strapi.log.warn(`[pipeline:${tag}] Failed to pause project antigravity: ${pauseErr.message}`);
        }
        return 'failed'; // Don't auto-retry — project is paused, recovery poll will handle it
      }
    }

    // Detect device environment errors (wrong cwd, missing dir) — no point retrying.
    if (session.metadata?.runner === 'desktop' && isDeviceEnvironmentError(error)) {
      strapi.log.warn(
        `[pipeline:${tag}] Session ${session.documentId}: device environment error, not retrying — ${error}`,
      );
      pipelineTelemetry.retriesExhausted++;
      await postPipelineComment(strapi, issueDocId,
        `Pipeline step **${skill}** failed: ${error}`,
        'pipeline',
      ).catch(() => {});
      return 'failed';
    }

    // Detect stale Claude CLI session — the sessionId no longer exists on the device.
    // Mark noResume so findResumableSession skips this session on future attempts,
    // and clear claudeSessionId so it doesn't pollute fresh-failure counting.
    if (isSessionNotFoundError(error)) {
      strapi.log.warn(
        `[pipeline:${tag}] Session ${session.documentId}: Claude CLI session not found, marking noResume`,
      );
      await strapi.documents(SESSION_UID).update({
        documentId: session.documentId,
        data: {
          claudeSessionId: null,
          metadata: { ...session.metadata, noResume: true, recoveryOutcome: 'failed', recoveryTag: tag },
        } as any,
      }).catch(() => {});
    }

    // Detect transient API overload (529) — retry with cooldown delay.
    if (isTransientOverloadError(error)) {
      strapi.log.warn(
        `[pipeline:${tag}] Session ${session.documentId}: transient overload (529), will retry after ${OVERLOAD_COOLDOWN_MS / 1000}s cooldown`,
      );
    }

    // Detect usage limit errors — disable device and don't retry on this device.
    if (session.metadata?.runner === 'desktop' && isUsageLimitError(error)) {
      const deviceId = session.metadata?.deviceId;
      if (deviceId) {
        await handleUsageLimitIfPresent(strapi, deviceId, error, undefined);
      }
      strapi.log.warn(
        `[pipeline:${tag}] Session ${session.documentId}: usage limit hit, device disabled — ${error.slice(0, 200)}`,
      );
    }

    // Detect Claude API 500 errors — pause device for 10 minutes.
    if (session.metadata?.runner === 'desktop' && isApiServerError(error)) {
      const deviceId = session.metadata?.deviceId;
      if (deviceId) {
        const until = new Date(Date.now() + API_SERVER_ERROR_DISABLE_MS);
        await disableDeviceUntil(strapi, deviceId, until);
        strapi.log.warn(
          `[pipeline:${tag}] Session ${session.documentId}: API 500 error, device ${deviceId} paused for 10m`,
        );
      }
    }

    // Auto-retry: create a new queued session directly via retryPipelineStep.
    if (opts.autoRetry) {
      try {
        const projectDoc = session.project?.documentId || session.project;
        let projectMap: Record<string, string> | undefined;
        if (projectDoc) {
          const proj = await strapi.documents('api::project.project' as any).findOne({
            documentId: typeof projectDoc === 'string' ? projectDoc : projectDoc,
            fields: ['antigravityProjectMap'],
          });
          projectMap = proj?.antigravityProjectMap || undefined;
        }
        const failCount = await countFailedFreshSessions(strapi, issueDocId, skill, projectMap);
        if (failCount >= MAX_FRESH_RETRIES) {
          strapi.log.warn(
            `[pipeline:${tag}] Session ${session.documentId}: ${skill} already failed ${failCount} times, not retrying`,
          );
          pipelineTelemetry.retriesExhausted++;

          // Transient overload (529) after 3 retries: disable device/runner for 1 hour
          if (isTransientOverloadError(error)) {
            const OVERLOAD_DISABLE_MS = 60 * 60 * 1000; // 1 hour
            const until = new Date(Date.now() + OVERLOAD_DISABLE_MS);
            const runner = session.metadata?.runner || 'desktop';

            if (runner === 'desktop') {
              const deviceId = session.metadata?.deviceId;
              if (deviceId) {
                await disableDeviceUntil(strapi, deviceId, until);
                strapi.log.warn(
                  `[pipeline:${tag}] Device ${deviceId} disabled for 1h due to repeated 529 overload`,
                );
              }
            } else if (runner === 'antigravity') {
              const runnerId = session.metadata?.runnerId;
              const model = session.metadata?.model;
              if (runnerId && model) {
                const { markModelDepleted } = await import('../antigravity-runner-pool');
                await markModelDepleted(runnerId, model, until);
                strapi.log.warn(
                  `[pipeline:${tag}] Antigravity runner ${runnerId} model "${model}" marked depleted for 1h due to repeated 529 overload`,
                );
              }
            }

            await postPipelineComment(strapi, issueDocId,
              `Pipeline step **${skill}** hit repeated 529 overload errors (${failCount} attempts). ${session.metadata?.runner === 'desktop' ? 'Device' : 'Runner'} disabled for 1 hour — will auto-retry after cooldown.`,
              'pipeline',
            ).catch(() => {});

            await strapi.documents(SESSION_UID).update({
              documentId: session.documentId,
              data: { metadata: { ...session.metadata, recoveryOutcome: 'failed', recoveryTag: tag, retriesExhausted: true, overloadDisabledUntil: until.toISOString() } } as any,
            }).catch(() => {});
            return 'failed';
          }

          // Only post comment + set manualHold if not already held (race guard)
          const currentIssue = await strapi.documents(ISSUE_UID).findOne({ documentId: issueDocId, fields: ['manualHold'] });
          if (!currentIssue?.manualHold) {
            await postPipelineComment(strapi, issueDocId,
              `Pipeline stopped for **${skill}**: failed ${failCount} attempts. Setting \`manualHold\` for manual intervention.`,
              'pipeline',
            ).catch(() => {});
            await strapi.documents(ISSUE_UID).update({
              documentId: issueDocId,
              data: { manualHold: true },
            }).catch(() => {});
          }
          await strapi.documents(SESSION_UID).update({
            documentId: session.documentId,
            data: { metadata: { ...session.metadata, recoveryOutcome: 'failed', recoveryTag: tag, retriesExhausted: true } } as any,
          }).catch(() => {});
          return 'failed';
        }

        const currentIssue = await strapi.documents(ISSUE_UID).findOne({
          documentId: issueDocId,
          fields: ['status'],
        });
        const currentStatus = currentIssue?.status;
        // Retry if issue hasn't moved to an unexpected status
        if (currentStatus === triggerStatus || currentStatus === 'in_progress') {
          strapi.log.info(
            `[pipeline:${tag}] Session ${session.documentId}: auto-retrying ${skill} (issue at ${currentStatus}, attempt ${failCount + 1}/${MAX_FRESH_RETRIES})`,
          );
          const runner = session.metadata?.runner || 'desktop';
          const model = session.metadata?.model;
          const retryAfter = isTransientOverloadError(error)
            ? new Date(Date.now() + OVERLOAD_COOLDOWN_MS).toISOString()
            : undefined;
          const { retryPipelineStep } = await import('../pipeline-orchestrator');
          await retryPipelineStep(strapi, issueDocId, skill, triggerStatus, runner, model, retryAfter);
          pipelineTelemetry.autoRetries++;
          // Persist autoRetried flag on session for DB health queries
          await strapi.documents(SESSION_UID).update({
            documentId: session.documentId,
            data: { metadata: { ...session.metadata, recoveryOutcome: 'failed', recoveryTag: tag, autoRetried: true } } as any,
          }).catch(() => {});
        } else {
          pipelineTelemetry.retriesExhausted++;
          await strapi.documents(SESSION_UID).update({
            documentId: session.documentId,
            data: { metadata: { ...session.metadata, recoveryOutcome: 'failed', recoveryTag: tag, retriesExhausted: true } } as any,
          }).catch(() => {});
        }
      } catch (retryErr: any) {
        strapi.log.warn(
          `[pipeline:${tag}] Session ${session.documentId}: auto-retry failed: ${retryErr.message}`,
        );
      }
    }

    return 'failed';
  }

  // No metadata to verify — just mark failed
  await updateSessionFailed(strapi, session, error);
  return 'failed';
}

/**
 * Periodically check for stale "running" pipeline sessions and promote
 * queued sessions that are stuck behind them. Runs every 2 minutes.
 */
export function startStaleSessionWatcher(strapi: any): void {
  const INTERVAL = 2 * 60 * 1000; // 2 minutes
  const STALE_THRESHOLD = 15 * 60 * 1000; // 15 minutes

  setInterval(async () => {
    pipelineTelemetry.staleWatcher.runs++;
    pipelineTelemetry.staleWatcher.lastRun = new Date().toISOString();

    try {
      const threshold = new Date(Date.now() - STALE_THRESHOLD).toISOString();

      const staleRunning = await strapi.documents(SESSION_UID).findMany({
        filters: {
          status: 'running',
          updatedAt: { $lt: threshold },
        },
        populate: ['issues', 'project'],
        limit: 50,
      });
      const staleSessions = staleRunning.filter(
        (s: any) => s.metadata?.type === 'pipeline'
          || (s.metadata?.origin === 'rest-api' && s.metadata?.runner === 'antigravity'),
      );

      for (const session of staleSessions) {
        const agRequestId = session.metadata?.requestId || session.metadata?.antigravityRequestId;
        if (session.metadata?.runner === 'antigravity' && agRequestId) {
          try {
            const { chatStatus, parseAntigravityResponse } = await import('../antigravity');
            const status = await chatStatus(agRequestId);
            const currentStatus = status.status || 'unknown';

            if (currentStatus === 'Completed') {
              const result = status.result || ({} as any);
              const response = parseAntigravityResponse(result.response || '');
              await strapi.documents(SESSION_UID).update({
                documentId: session.documentId,
                data: {
                  status: 'completed',
                  messages: [
                    ...(session.messages || []),
                    { role: 'assistant', content: response, timestamp: Date.now() },
                  ],
                  metadata: {
                    ...session.metadata,
                    elapsedSeconds: result.elapsedSeconds,
                    recoveredByWatcher: true,
                  },
                } as any,
              });
              strapi.log.info(
                `[pipeline-watcher] Recovered stale session ${session.documentId} — actually completed in ${result.elapsedSeconds}s`,
              );
              const projectDocId = session.project?.documentId;
              if (projectDocId) {
                const { dispatchNextForProject } = await import('../pipeline-orchestrator');
                await dispatchNextForProject(strapi, projectDocId, 'antigravity');
              }
              continue;
            } else if (currentStatus === 'Running' || currentStatus === 'Pending') {
              const title = session.title || '';
              await strapi.documents(SESSION_UID).update({
                documentId: session.documentId,
                data: {
                  title: title.replace(/ \[polled\]$/, '') + ' [polled]',
                  metadata: { ...session.metadata, lastPolled: Date.now() },
                } as any,
              });
              strapi.log.info(
                `[pipeline-watcher] Session ${session.documentId} still ${currentStatus} on Antigravity, refreshed updatedAt`,
              );
              continue;
            }
            // Failed or unknown — fall through to mark failed
          } catch (err: any) {
            strapi.log.warn(
              `[pipeline-watcher] Failed to check Antigravity status for ${session.documentId}: ${err.message}`,
            );
          }
        }

        // Build failure reason
        let failReason = 'Session timed out (no activity for >15m)';
        if (session.metadata?.runner !== 'antigravity' && session.metadata?.deviceId) {
          const { isDeviceConnected } = await import('../websocket');
          if (!isDeviceConnected(session.metadata.deviceId)) {
            failReason = `Device ${session.metadata.deviceId} disconnected, session cannot complete`;
          }
        }

        // Centralized recovery: check issue advancement, mark completed or failed, auto-retry
        const outcome = await recoverOrFailSession(strapi, session, failReason, { tag: 'watcher', autoRetry: true });
        if (outcome === 'recovered') {
          pipelineTelemetry.staleWatcher.sessionsRecovered++;
          strapi.log.info(`[pipeline-watcher] Stale session ${session.documentId} (${session.title}) — recovered (issue already advanced)`);
          const projectDocId = session.project?.documentId;
          if (projectDocId) {
            const { dispatchNextForProject } = await import('../pipeline-orchestrator');
            await dispatchNextForProject(strapi, projectDocId, session.metadata?.runner || 'desktop');
          }
        } else {
          pipelineTelemetry.staleWatcher.sessionsFailed++;
          strapi.log.warn(`[pipeline-watcher] Stale session ${session.documentId} (${session.title}) → ${outcome}: ${failReason}`);
        }
      }

      await dispatchAllQueued(strapi, 'pipeline-watcher');
    } catch (err: any) {
      strapi.log.warn(`[pipeline-watcher] Error: ${err.message}`);
    }
  }, INTERVAL);

  strapi.log.info('[pipeline-watcher] Started stale session watcher (every 2m, running 15m stale threshold)');
}
