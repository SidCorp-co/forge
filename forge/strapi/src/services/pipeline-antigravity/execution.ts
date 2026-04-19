import * as antigravity from '../antigravity';
import { parseAntigravityResponse, generateForgeCli } from '../antigravity';
import { uploadProjectConfig } from '../antigravity/client';
import { refreshRunnerQuota, refreshRunnerQuotaWithProject, getDepletedModelRefreshTime } from '../antigravity-quota';
import { markModelDepleted, disableRunnerUntil } from '../antigravity-runner-pool';
import { sendToSession } from '../websocket';
import { SESSION_UID, sleep, recoverOrFailSession } from '../pipeline-utils';

import { PipelineConfig } from './types';
import {
    RUNNER_UID,
    POLL_TIMEOUT,
    MAX_POLL_ERRORS,
    POLL_ERROR_BACKOFF_BASE,
    QUOTA_ERROR_PATTERN,
    QUOTA_RESPONSE_PATTERN,
    POLL_BACKOFF_TIERS,
    HIGH_TRAFFIC_PATTERN,
    HIGH_TRAFFIC_MAX_RETRIES,
    HIGH_TRAFFIC_RETRY_DELAY,
    HIGH_TRAFFIC_DISABLE_MS,
    HIGH_TRAFFIC_COMPLETED_DISABLE_MS,
    throttleRunner
} from './constants';
import { buildAntigravityPrompt } from './prompts';
import { buildAntigravityContext } from '../pipeline-preamble';

/** Look up a runner's endpoint URL for direct /usage calls. */
async function getRunnerEndpoint(strapi: any, runnerId: string): Promise<string | undefined> {
    try {
        const runner = await strapi.documents(RUNNER_UID).findOne({ documentId: runnerId });
        return runner?.endpoint || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Handle quota exhaustion: mark model depleted, re-queue session, notify UI.
 * Reusable across all failure paths (Completed response, Failed error, chatAsync throw).
 */
async function handleQuotaExhaustion(
    strapi: any,
    session: any,
    issue: any,
    skill: string,
    preferredModel: string | undefined,
    errorText: string,
    requestId?: string,
): Promise<void> {
    strapi.log.warn(`[pipeline] ISS-${issue.id}: Quota exhausted (skill=${skill}), re-queuing`);

    const runnerId = session.metadata?.runnerId || session.metadata?.antigravityRunnerId || '__legacy__';

    // Fetch fresh quota data before determining reset time (don't rely on stale cache)
    let quotaResetAt: Date | null = null;
    if (runnerId !== '__legacy__') {
        const runnerEndpoint = await getRunnerEndpoint(strapi, runnerId);

        // Quota is per-runner (agentId) — any working projectId returns the same data.
        // Try runner-wide refresh first (uses all mapped projectIds).
        await refreshRunnerQuota(runnerId, runnerEndpoint).catch(() => { });
        quotaResetAt = getDepletedModelRefreshTime(runnerId, preferredModel);

        // If all mapped projectIds are stale (404), use the session's own projectId —
        // it was just active on this runner so its /usage endpoint should work.
        if (!quotaResetAt) {
            const sessionProjectId = session.metadata?.antigravityProjectId;
            if (sessionProjectId) {
                await refreshRunnerQuotaWithProject(runnerId, sessionProjectId, runnerEndpoint).catch(() => { });
                quotaResetAt = getDepletedModelRefreshTime(runnerId, preferredModel);
            }
        }
    }

    // Last-resort fallback: 1 hour
    if (!quotaResetAt) quotaResetAt = new Date(Date.now() + 60 * 60 * 1000);

    const depletedModel = preferredModel || 'default';
    markModelDepleted(runnerId, depletedModel, quotaResetAt).catch(() => { });

    await strapi.documents(SESSION_UID).update({
        documentId: session.documentId,
        data: {
            status: 'queued',
            messages: [
                ...session.messages,
                { role: 'assistant', content: errorText.slice(0, 500), timestamp: Date.now() },
            ],
            metadata: {
                ...session.metadata,
                ...(requestId ? { requestId } : {}),
                quotaExhaustedAt: new Date().toISOString(),
                depletedModel,
            },
        } as any,
    });

    notifySessionError(session.documentId, `Quota exhausted — session re-queued, waiting for quota reset at ${quotaResetAt.toISOString()}`);
}

/**
 * Execute pipeline step via Antigravity service (server-side).
 * Uses async mode + polling so we can stream progress to the UI
 * via WebSocket instead of blocking on a sync call that may timeout.
 */
export async function executeAntigravityStep(
    strapi: any,
    session: any,
    issue: any,
    _prompt: string,
    _pipelineConfig: PipelineConfig,
    stepConfig: { model?: string },
    skill: string,
): Promise<void> {
    // Use runner-resolved projectId from session metadata, or fall back to legacy
    const antigravityProjectId = session.metadata?.antigravityProjectId
        || (issue.project as any).antigravityProjectId;

    // Session is already marked 'running' by promoteQueuedSession.
    // Pre-fetch project context (knowledge + conventions + pipeline rules)
    let contextBlock = '';
    try {
        contextBlock = await buildAntigravityContext(strapi, issue.project.documentId);
    } catch (err: any) {
        strapi.log.warn(`[pipeline] ISS-${issue.id}: context pre-fetch failed (non-fatal): ${err.message}`);
    }

    // Build skill-specific prompt with API instructions + pre-fetched context
    const message = buildAntigravityPrompt(skill, issue, issue.project, contextBlock) || _prompt;

    let preferredModel = stepConfig.model || issue.project.agentConfig?.antigravityModel || undefined;

    try {
        // Upload fresh forge-api.mjs to the Antigravity project before each session
        const projectApiKey = (issue.project as any).apiKey;
        if (projectApiKey) {
            const baseUrl = process.env.FORGE_PUBLIC_URL || 'http://localhost:1337';
            const cliSource = generateForgeCli(`${baseUrl}/api`, projectApiKey);
            await uploadProjectConfig(antigravityProjectId, Buffer.from(cliSource, 'utf-8'), 'forge-api.mjs', false).catch((err: any) => {
                strapi.log.warn(`[pipeline] ISS-${issue.id}: forge-api.mjs upload failed (non-fatal): ${err.message}`);
            });
        }

        // Throttle: prevent 429 bursts when multiple sessions target the same runner
        const runnerId = session.metadata?.runnerId || session.metadata?.antigravityRunnerId || '__legacy__';
        await throttleRunner(runnerId);

        // Start async chat with retry for transient high-traffic (429) errors.
        // Retries in-place up to 3 times before falling through to error handling.
        let asyncResp: { requestId: string };
        let lastChatErr: any = null;

        for (let attempt = 0; attempt <= HIGH_TRAFFIC_MAX_RETRIES; attempt++) {
            try {
                asyncResp = await antigravity.chatAsync({
                    projectId: antigravityProjectId,
                    message,
                    model: preferredModel,
                    newSession: true,
                });
                lastChatErr = null;
                break;
            } catch (chatErr: any) {
                // If the error looks like a null reference (likely bad model mapping), retry without model
                if (attempt === 0 && preferredModel && /null|object reference/i.test(chatErr.message)) {
                    strapi.log.warn(
                        `[pipeline] ISS-${issue.id}: Antigravity failed with model=${preferredModel}, retrying with default model: ${chatErr.message}`,
                    );
                    preferredModel = undefined;
                    continue;
                }

                // Transient high-traffic: wait and retry
                if (HIGH_TRAFFIC_PATTERN.test(chatErr.message) && attempt < HIGH_TRAFFIC_MAX_RETRIES) {
                    const delay = HIGH_TRAFFIC_RETRY_DELAY * Math.pow(2, attempt);
                    strapi.log.warn(
                        `[pipeline] ISS-${issue.id}: High traffic (attempt ${attempt + 1}/${HIGH_TRAFFIC_MAX_RETRIES}), retrying in ${delay / 1000}s`,
                    );
                    await sleep(delay);
                    lastChatErr = chatErr;
                    continue;
                }

                // Non-retryable or retries exhausted
                throw chatErr;
            }
        }

        if (lastChatErr) throw lastChatErr;

        const requestId = asyncResp.requestId;
        strapi.log.info(`[pipeline] ISS-${issue.id}: Antigravity async started, requestId=${requestId}`);

        // Persist requestId immediately so boot recovery can poll it if the server restarts
        await strapi.documents(SESSION_UID).update({
            documentId: session.documentId,
            data: {
                metadata: { ...session.metadata, requestId },
            } as any,
        });

        // Notify UI that the agent is running
        sendToSession(session.documentId, 'agent:message', {
            sessionId: session.documentId,
            type: 'text',
            content: `Antigravity agent started (${skill})...`,
        });

        // Poll until completed, failed, or timeout.
        // Tolerates transient poll failures (network blips, 502s) by retrying
        // up to MAX_POLL_ERRORS times with backoff before giving up.
        const startTime = Date.now();
        let lastStatus = 'Pending';
        let consecutivePollErrors = 0;
        let backoffTierIndex = 0;

        while (Date.now() - startTime < POLL_TIMEOUT) {
            await sleep(POLL_BACKOFF_TIERS[backoffTierIndex]);

            let status: any;
            try {
                status = await antigravity.chatStatus(requestId);
                consecutivePollErrors = 0; // reset on success
            } catch (pollErr: any) {
                consecutivePollErrors++;
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
                strapi.log.warn(
                    `[pipeline] ISS-${issue.id}: poll error ${consecutivePollErrors}/${MAX_POLL_ERRORS} at ${elapsed}s: ${pollErr.message}`,
                );

                if (consecutivePollErrors >= MAX_POLL_ERRORS) {
                    // Too many consecutive failures — use centralized recovery
                    const outcome = await recoverOrFailSession(strapi, session,
                        `Polling failed ${consecutivePollErrors}x consecutively after ${elapsed}s`,
                        { tag: 'poll-errors', autoRetry: true },
                    );
                    if (outcome === 'recovered') {
                        notifySessionComplete(session.documentId);
                    } else {
                        notifySessionError(session.documentId, `Polling failed ${consecutivePollErrors}x after ${elapsed}s`);
                    }
                    return;
                }

                // Exponential backoff before retrying (2s, 4s, 8s, 16s, ...)
                await sleep(Math.pow(2, consecutivePollErrors) * POLL_ERROR_BACKOFF_BASE);
                continue;
            }

            const currentStatus = status.status || 'unknown';

            // Adaptive backoff: escalate tier when status is unchanged, reset on state change
            if (currentStatus !== lastStatus) {
                backoffTierIndex = 0;
                lastStatus = currentStatus;
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
                sendToSession(session.documentId, 'agent:message', {
                    sessionId: session.documentId,
                    type: 'text',
                    content: `[${elapsed}s] Status: ${currentStatus}`,
                });
            } else {
                // Status unchanged — escalate to next backoff tier (capped at max)
                backoffTierIndex = Math.min(backoffTierIndex + 1, POLL_BACKOFF_TIERS.length - 1);
            }

            // Early quota detection: check error/result even while Running.
            // Antigravity may keep status "Running" while the agent outputs
            // "Model quota reached" repeatedly — detect and short-circuit.
            // Use broad pattern on error field, strict pattern on response text to avoid false positives.
            const earlyQuotaHit = QUOTA_ERROR_PATTERN.test(status.error || '')
                || QUOTA_RESPONSE_PATTERN.test(status.result?.response || '');
            if (currentStatus === 'Running' && earlyQuotaHit) {
                const earlyQuotaText = [status.error || '', status.result?.response || ''].join(' ');
                strapi.log.warn(`[pipeline] ISS-${issue.id}: Quota detected while still Running, short-circuiting`);
                await handleQuotaExhaustion(strapi, session, issue, skill, preferredModel, earlyQuotaText, requestId);
                return;
            }

            if (currentStatus === 'Completed') {
                const result = status.result || ({} as any);
                const response = parseAntigravityResponse(result.response || '');

                // Detect agent-level failures: Antigravity returns "Completed" but
                // the agent crashed mid-task without finishing its work.
                const agentFailed = /agent terminated due to error/i.test(response);

                // Detect quota/rate-limit exhaustion in the response text (strict pattern — agent output may discuss quota concepts).
                const quotaExhausted = QUOTA_RESPONSE_PATTERN.test(result.response || '')
                    || QUOTA_ERROR_PATTERN.test(status.error || '');

                const highTrafficCompleted = HIGH_TRAFFIC_PATTERN.test(result.response || '');

                // Stream the final response to UI
                sendToSession(session.documentId, 'agent:message', {
                    sessionId: session.documentId,
                    type: (agentFailed || quotaExhausted || highTrafficCompleted) ? 'error' : 'text',
                    content: response,
                });

                if (quotaExhausted) {
                    await handleQuotaExhaustion(strapi, session, issue, skill, preferredModel, response, requestId);
                    return;
                }

                if (highTrafficCompleted) {
                    const rId = session.metadata?.runnerId || session.metadata?.antigravityRunnerId || '__legacy__';
                    const until = new Date(Date.now() + HIGH_TRAFFIC_COMPLETED_DISABLE_MS);
                    strapi.log.warn(`[pipeline] ISS-${issue.id}: Completed response contains high-traffic message, disabling runner ${rId} for 5m`);
                    await disableRunnerUntil(rId, until).catch(() => {});
                    await strapi.documents(SESSION_UID).update({
                        documentId: session.documentId,
                        data: {
                            status: 'queued',
                            metadata: {
                                ...session.metadata,
                                requestId,
                                highTrafficPausedAt: new Date().toISOString(),
                                highTrafficResumeAt: until.toISOString(),
                            },
                        } as any,
                    });
                    notifySessionError(session.documentId, `High traffic — runner paused for 5 minutes, session re-queued`);
                    return;
                }

                if (agentFailed) {
                    const errorMsg = `Antigravity agent terminated due to error (skill=${skill})`;
                    const outcome = await recoverOrFailSession(strapi, session, errorMsg, { tag: 'agent-error', autoRetry: true });
                    if (outcome === 'recovered') {
                        notifySessionComplete(session.documentId);
                    } else {
                        notifySessionError(session.documentId, errorMsg);
                        strapi.log.error(`[pipeline] ISS-${issue.id}: ${errorMsg} — response: ${response.slice(0, 200)}`);
                    }
                    return;
                }

                // Normal completion
                await strapi.documents(SESSION_UID).update({
                    documentId: session.documentId,
                    data: {
                        status: 'completed',
                        messages: [
                            ...session.messages,
                            { role: 'assistant', content: response, timestamp: Date.now() },
                        ],
                        metadata: {
                            ...session.metadata,
                            requestId,
                            elapsedSeconds: result.elapsedSeconds,
                        },
                    } as any,
                });

                sendToSession(session.documentId, 'agent:complete', { sessionId: session.documentId });
                strapi.log.info(`[pipeline] ISS-${issue.id}: Antigravity completed in ${result.elapsedSeconds}s`);
                return;
            }

            if (currentStatus === 'Failed' || status.error) {
                const errorMsg = status.error || 'Antigravity task failed';

                // Check if the failure is a quota error — re-queue instead of retry
                if (QUOTA_ERROR_PATTERN.test(errorMsg)) {
                    await handleQuotaExhaustion(strapi, session, issue, skill, preferredModel, errorMsg, requestId);
                    return;
                }

                // High traffic: disable the runner for 15 minutes and re-queue
                if (HIGH_TRAFFIC_PATTERN.test(errorMsg)) {
                    const rId = session.metadata?.runnerId || session.metadata?.antigravityRunnerId || '__legacy__';
                    const until = new Date(Date.now() + HIGH_TRAFFIC_DISABLE_MS);
                    strapi.log.warn(`[pipeline] ISS-${issue.id}: High traffic failure, disabling runner ${rId} for 5m`);
                    await disableRunnerUntil(rId, until).catch(() => {});
                    await strapi.documents(SESSION_UID).update({
                        documentId: session.documentId,
                        data: {
                            status: 'queued',
                            metadata: {
                                ...session.metadata,
                                requestId,
                                highTrafficPausedAt: new Date().toISOString(),
                                highTrafficResumeAt: until.toISOString(),
                            },
                        } as any,
                    });
                    notifySessionError(session.documentId, `High traffic — runner paused for 5 minutes, session re-queued`);
                    return;
                }

                const outcome = await recoverOrFailSession(strapi, session, errorMsg, { tag: 'ag-failed', autoRetry: true });
                if (outcome === 'recovered') {
                    notifySessionComplete(session.documentId);
                } else {
                    notifySessionError(session.documentId, errorMsg);
                    strapi.log.error(
                        `[pipeline] ISS-${issue.id}: Antigravity failed: ${errorMsg} (skill=${skill}, model=${preferredModel || 'default'}, projectId=${antigravityProjectId})`,
                    );
                }
                return;
            }
        }

        // Timeout — verify before marking failed
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const timeoutMsg = `Antigravity timed out after ${elapsed}s`;
        const outcome = await recoverOrFailSession(strapi, session, timeoutMsg, { tag: 'timeout', autoRetry: true });
        if (outcome === 'recovered') {
            notifySessionComplete(session.documentId);
        } else {
            notifySessionError(session.documentId, timeoutMsg);
            strapi.log.warn(`[pipeline] ISS-${issue.id}: ${timeoutMsg}`);
        }
    } catch (err: any) {
        const errorDetail = `Antigravity error: ${err.message} (skill=${skill}, model=${preferredModel || 'default'}, projectId=${antigravityProjectId})`;
        strapi.log.error(`[pipeline] ISS-${issue.id}: ${errorDetail}`);

        // Check if the thrown error is a quota error (e.g. chatAsync HTTP 429 with quota message)
        if (QUOTA_ERROR_PATTERN.test(err.message)) {
            await handleQuotaExhaustion(strapi, session, issue, skill, preferredModel, err.message);
            return;
        }

        // High-traffic retries exhausted: disable the runner for 15 minutes and re-queue
        if (HIGH_TRAFFIC_PATTERN.test(err.message)) {
            const runnerId = session.metadata?.runnerId || session.metadata?.antigravityRunnerId || '__legacy__';
            const until = new Date(Date.now() + HIGH_TRAFFIC_DISABLE_MS);
            strapi.log.warn(`[pipeline] ISS-${issue.id}: High traffic retries exhausted, disabling runner ${runnerId} for 5m`);
            await disableRunnerUntil(runnerId, until).catch(() => {});
            await strapi.documents(SESSION_UID).update({
                documentId: session.documentId,
                data: {
                    status: 'queued',
                    metadata: {
                        ...session.metadata,
                        highTrafficPausedAt: new Date().toISOString(),
                        highTrafficResumeAt: until.toISOString(),
                    },
                } as any,
            });
            notifySessionError(session.documentId, `High traffic — runner paused for 5 minutes, session re-queued`);
            return;
        }

        const outcome = await recoverOrFailSession(strapi, session, errorDetail, { tag: 'catch', autoRetry: true });
        if (outcome === 'recovered') {
            notifySessionComplete(session.documentId);
        } else {
            notifySessionError(session.documentId, `Error: ${err.message}`);
        }
    }
}

// ─── UI Notification Helper ──────────────────────────────────────────────────

/** Send complete event to the session's WebSocket subscribers. */
export function notifySessionComplete(sessionDocumentId: string): void {
    sendToSession(sessionDocumentId, 'agent:complete', {
        sessionId: sessionDocumentId,
    });
}

/** Send error + complete events to the session's WebSocket subscribers. */
export function notifySessionError(sessionDocumentId: string, errorMsg: string): void {
    sendToSession(sessionDocumentId, 'agent:message', {
        sessionId: sessionDocumentId,
        type: 'error',
        content: errorMsg,
    });
    sendToSession(sessionDocumentId, 'agent:complete', {
        sessionId: sessionDocumentId,
    });
}
