/**
 * Pipeline Runners
 *
 * Desktop and Antigravity execution for pipeline steps.
 * Both runners are dispatched by the unified DB queue in pipeline-orchestrator.
 */

import { sendToDevice, sendToSession } from './websocket';
import { SESSION_UID, findResumableSession, updateSessionFailed, MAX_RESUMABLE_CONTEXT } from './pipeline-utils';
import { executeAntigravityStep, type PipelineConfig } from './pipeline-antigravity';
import { resolveRepoPath } from './resolve-repo-path';
import { hasAnyQuota, hasAnyQuotaForRunner } from './antigravity-quota';
import { findAvailableDevice } from './device-pool';
import { findAvailableRunner, clearRunnerAllocation, checkModelDepleted } from './antigravity-runner-pool';
import { needsSkillSync, syncSkills } from './antigravity';
import { buildDesktopPreamble } from './pipeline-preamble';

/**
 * Context-save threshold: when a resumed session's context exceeds this,
 * append an instruction for Claude to persist key context to the issue.
 * Set below MAX_RESUMABLE_CONTEXT so the save happens before the session
 * becomes non-resumable (i.e. the NEXT resume will start fresh and need it).
 */
const CONTEXT_SAVE_THRESHOLD = MAX_RESUMABLE_CONTEXT * 0.65; // ~390K

const CONTEXT_SAVE_INSTRUCTION = `

IMPORTANT — SESSION CONTEXT SAVE
This session's context is large. Before completing your current task, save key context to the issue so future sessions have continuity. Use the forge_issues MCP tool to update the issue:

Update the issue's sessionContext field with a JSON object:
- currentState: one sentence on where the work left off
- decisions: array of key decisions made (include file paths)
- filesModified: array of files created or changed
- errorsResolved: array of errors hit and how they were fixed
- reviewFeedback: array of review feedback addressed (if any)

If the issue already has sessionContext, merge: increment sessionCount, append new items to arrays (skip duplicates), replace currentState with latest.
If no existing sessionContext, set sessionCount to 1.
Always set lastUpdated to the current ISO timestamp.`;

/**
 * Format an issue's sessionContext into a prompt preamble for fresh sessions.
 */
function formatSessionContext(ctx: any): string {
  const parts: string[] = ['## Previous Session Context'];
  if (ctx.currentState) parts.push(`**Current state:** ${ctx.currentState}`);
  if (ctx.decisions?.length) {
    parts.push('**Key decisions:**');
    for (const d of ctx.decisions.slice(-10)) parts.push(`- ${d}`);
  }
  if (ctx.filesModified?.length) {
    parts.push(`**Files touched:** ${ctx.filesModified.slice(-15).join(', ')}`);
  }
  if (ctx.errorsResolved?.length) {
    parts.push('**Errors resolved:**');
    for (const e of ctx.errorsResolved.slice(-5)) parts.push(`- ${e}`);
  }
  if (ctx.reviewFeedback?.length) {
    parts.push('**Review feedback:**');
    for (const f of ctx.reviewFeedback.slice(-5)) parts.push(`- ${f}`);
  }
  parts.push(`_Context from ${ctx.sessionCount || '?'} previous session(s), last updated ${ctx.lastUpdated || 'unknown'}_`);
  return parts.join('\n');
}

/**
 * Resume an existing desktop Claude CLI session with a new pipeline step prompt.
 * Appends the prompt as a new user message and sends agent:send instead of agent:start.
 */
export async function resumeDesktopSession(
  strapi: any,
  session: any,
  issue: any,
  prompt: string,
  skill: string,
  fromStatus: string,
  toStatus: string,
  retryCount = 0,
  deviceName?: string | null,
): Promise<void> {
  const now = Date.now();

  // If context is approaching the resume limit, tell Claude to persist
  // key context to the issue so fresh sessions have continuity.
  const contextUsed = session.usage?.contextUsed || 0;
  const effectivePrompt = contextUsed > CONTEXT_SAVE_THRESHOLD
    ? prompt + CONTEXT_SAVE_INSTRUCTION
    : prompt;

  const messages = [...(session.messages || []), { role: 'user', content: effectivePrompt, timestamp: now }];

  // Update session: set running, append new prompt, update metadata
  await strapi.documents(SESSION_UID).update({
    documentId: session.documentId,
    data: {
      status: 'running',
      messages,
      title: `${skill}: ISS-${issue.id} ${issue.title}`.slice(0, 120),
      metadata: {
        ...(session.metadata || {}),
        type: 'pipeline',
        skill,
        fromStatus,
        toStatus,
        runner: 'desktop',
        retryCount,
        deviceId: session.metadata?.deviceId || issue.project.defaultDevice?.deviceId || null,
        deviceName: deviceName || session.metadata?.deviceName || issue.project.defaultDevice?.name || undefined,
      },
    } as any,
  });

  // Notify web UI of the new user message (show original prompt, not the save instruction)
  sendToSession(session.documentId, 'agent:user-message', {
    sessionId: session.documentId,
    content: prompt,
  });

  // Send follow-up message to desktop device (prefer session's device for resume consistency)
  const deviceId: string | null = session.metadata?.deviceId || issue.project.defaultDevice?.deviceId || null;
  const rp = await resolveRepoPath(strapi, issue.project.slug, deviceId, undefined, issue.project.repoPath);
  strapi.log.info(
    `[pipeline] ISS-${issue.id}: resume → deviceId=${deviceId || 'NONE'}, claude=${session.claudeSessionId}, ctx=${contextUsed}${contextUsed > CONTEXT_SAVE_THRESHOLD ? ' (save requested)' : ''}`,
  );

  // Auto-sync skills to desktop device if they've been updated
  if (deviceId) {
    try {
      await pushSkillsToDeviceIfNeeded(strapi, issue.project.documentId, deviceId);
    } catch (err: any) {
      strapi.log.warn(`[pipeline] ISS-${issue.id}: desktop skill sync failed (non-fatal): ${err.message}`);
    }
  }

  if (deviceId) {
    setTimeout(() => {
      const connected = sendToDevice(deviceId, 'agent:send', {
        sessionId: session.documentId,
        message: effectivePrompt,
        claudeSessionId: session.claudeSessionId,
        repoPath: rp,
        projectSlug: issue.project.slug,
      });
      strapi.log.info(
        `[pipeline] ISS-${issue.id}: agent:send dispatched to device ${deviceId}, connected=${connected}`,
      );
    }, 500);
  } else {
    strapi.log.warn(
      `[pipeline] ISS-${issue.id}: no device connected, session ${session.documentId} resumed but not sent`,
    );
  }
}

/**
 * Push latest skills to a desktop device via WebSocket if skills have been
 * updated since the project's last sync. The desktop app writes them to
 * .claude/skills/ so Claude CLI picks them up on the next session.
 */
async function pushSkillsToDeviceIfNeeded(
  strapi: any,
  projectDocumentId: string,
  deviceId: string,
): Promise<void> {
  if (!await needsSkillSync(strapi, projectDocumentId)) return;

  const skills = await strapi.documents('api::skill.skill').findMany({
    filters: {
      $or: [
        { isGlobal: true },
        { project: { documentId: projectDocumentId } },
      ],
    },
    fields: ['name', 'description', 'version', 'skillMd', 'files', 'target', 'contentHash', 'localGuide'],
    limit: 100,
  });

  if (!skills.length) return;

  const payload = skills.map((s: any) => ({
    name: s.name,
    description: s.description || '',
    version: s.version || '1.0.0',
    skillMd: s.target === 'dev' ? s.skillMd : undefined,
    localGuide: s.localGuide || undefined,
    target: s.target || 'dev',
    contentHash: s.contentHash || '',
    files: s.target === 'dev' ? (s.files || []) : [],
  }));

  const sent = sendToDevice(deviceId, 'skills:push', { skills: payload });
  if (sent) {
    strapi.log.info(`[pipeline] Pushed ${skills.length} skills to device ${deviceId}`);
    await strapi.documents('api::project.project' as any).update({
      documentId: projectDocumentId,
      data: { skillsSyncedAt: new Date().toISOString() },
    });
  }
}

/**
 * Per-skill model override for desktop `claude -p --model`.
 * Returns undefined to use the CLI default.
 */
function modelForSkill(skill?: string): string | undefined {
  return undefined;
}

/**
 * Execute pipeline step via desktop device (Claude CLI).
 */
export async function runViaDesktop(
  strapi: any,
  session: any,
  issue: any,
  prompt: string,
  preAllocatedDeviceId?: string | null,
  skill?: string,
): Promise<void> {
  // Use pre-allocated deviceId from promoteQueuedSession if available,
  // otherwise allocate now (fallback for direct calls).
  const deviceId: string | null = preAllocatedDeviceId !== undefined
    ? preAllocatedDeviceId
    : (await findAvailableDevice(issue.project.documentId))?.deviceId ?? null;
  const rp = session.repoPath || await resolveRepoPath(strapi, issue.project.slug, deviceId, undefined, issue.project.repoPath);

  // Pre-fetch project context (knowledge + conventions + rules) to eliminate
  // tool calls that would otherwise replay in conversation history on every turn.
  // This goes into `--append-system-prompt` on the desktop side so Claude API
  // prefix-caches it across consecutive pipeline steps in the same project.
  let systemPrompt = '';
  try {
    systemPrompt = await buildDesktopPreamble(strapi, issue.project.documentId);
  } catch (err: any) {
    strapi.log.warn(`[pipeline] ISS-${issue.id}: preamble build failed (non-fatal): ${err.message}`);
  }

  // For fresh sessions, inject sessionContext from the issue if available.
  // This gives Claude continuity from previous sessions that exceeded the resume threshold.
  const ctx = issue.sessionContext;
  const contextPrefix = ctx?.currentState ? `${formatSessionContext(ctx)}\n\n` : '';
  const effectivePrompt = `${contextPrefix}${prompt}`;

  // Persist the exact Strapi-side inputs to session metadata so they can be
  // inspected after the fact. Note: the desktop Rust side prepends its own
  // FORGE_SYSTEM_PREAMBLE to systemPrompt before calling `claude --append-system-prompt`,
  // so the on-wire value here is the Strapi half only.
  try {
    await strapi.documents(SESSION_UID).update({
      documentId: session.documentId,
      data: {
        metadata: {
          ...(session.metadata || {}),
          debug: {
            systemPrompt,
            systemPromptLength: systemPrompt.length,
            effectivePrompt,
            effectivePromptLength: effectivePrompt.length,
            capturedAt: new Date().toISOString(),
          },
        },
      } as any,
    });
  } catch (err: any) {
    strapi.log.warn(`[pipeline] ISS-${issue.id}: failed to persist debug metadata (non-fatal): ${err.message}`);
  }

  strapi.log.info(`[pipeline] ISS-${issue.id}: start → deviceId=${deviceId || 'NONE'}${ctx?.currentState ? ', has sessionContext' : ''}, systemPrompt=${systemPrompt.length}ch, prompt=${effectivePrompt.length}ch`);

  // Auto-sync skills to desktop device if they've been updated
  if (deviceId) {
    try {
      await pushSkillsToDeviceIfNeeded(strapi, issue.project.documentId, deviceId);
    } catch (err: any) {
      strapi.log.warn(`[pipeline] ISS-${issue.id}: desktop skill sync failed (non-fatal): ${err.message}`);
    }
  }

  if (deviceId) {
    const model = modelForSkill(skill);
    setTimeout(() => {
      const connected = sendToDevice(deviceId, 'agent:start', {
        sessionId: session.documentId,
        repoPath: rp,
        prompt: effectivePrompt,
        systemPrompt,
        skill,
        model,
        projectSlug: issue.project.slug,
        preBuilt: true,
      });
      strapi.log.info(`[pipeline] ISS-${issue.id}: agent:start dispatched, connected=${connected}, skill=${skill || '-'}, model=${model || 'default'}`);
    }, 500);
  } else {
    strapi.log.warn(
      `[pipeline] ISS-${issue.id}: no device connected, session ${session.documentId} created but not started`,
    );
  }
}

/**
 * Execute pipeline step via Antigravity service.
 * Called by promoteQueuedSession — session is already marked 'running'.
 * After completion (success or failure), dispatches the next queued job.
 */
export async function runViaAntigravity(
  strapi: any,
  session: any,
  issue: any,
  _prompt: string,
  pipelineConfig: PipelineConfig,
  stepConfig: { model?: string },
  skill: string,
): Promise<void> {
  // Use pre-allocated runner from session metadata (set by promoteQueuedSession),
  // or allocate now as fallback for direct calls.
  const preAllocated = session.metadata?.antigravityRunnerId;
  let runnerId: string;
  let runnerName: string;
  let antigravityProjectId: string;

  if (preAllocated) {
    runnerId = session.metadata.antigravityRunnerId;
    runnerName = session.metadata.antigravityRunnerName || runnerId;
    antigravityProjectId = session.metadata.antigravityProjectId;
  } else {
    const allocation = await findAvailableRunner(issue.project.documentId);
    if (!allocation) {
      strapi.log.warn(
        `[pipeline] ISS-${issue.id}: antigravity runner selected but no runner available`,
      );
      await updateSessionFailed(strapi, session, 'No Antigravity runner available');
      const { dispatchNextForProject } = await import('./pipeline-orchestrator');
      await dispatchNextForProject(strapi, issue.project.documentId, 'antigravity');
      return;
    }

    ({ runnerId, runnerName, antigravityProjectId } = allocation);

    session.metadata = {
      ...(session.metadata || {}),
      antigravityRunnerId: runnerId,
      antigravityRunnerName: runnerName,
      antigravityRunnerAgentId: allocation.agentId,
      antigravityProjectId,
    };
    await strapi.documents(SESSION_UID).update({
      documentId: session.documentId,
      data: { metadata: session.metadata } as any,
    });

    if (runnerId !== '__legacy__') {
      clearRunnerAllocation(runnerId);
    }
  }

  // Auto-sync skills if they've been updated since last sync
  try {
    if (await needsSkillSync(strapi, issue.project.documentId)) {
      strapi.log.info(`[pipeline] ISS-${issue.id}: skills updated, syncing to Antigravity project ${antigravityProjectId} on ${runnerName}`);
      await syncSkills(strapi, antigravityProjectId, issue.project.documentId);
    }
  } catch (err: any) {
    strapi.log.warn(`[pipeline] ISS-${issue.id}: skill sync failed (non-fatal): ${err.message}`);
  }

  // Check quota before running — if depleted, re-queue
  const agConfig = (issue.project as any).agentConfig || {};
  const preferredModel = stepConfig.model || agConfig.antigravityModel;

  // Check if this specific model is marked depleted on this runner (per-model gate)
  const depletedUntil = await checkModelDepleted(runnerId, preferredModel || 'default');
  if (depletedUntil) {
    strapi.log.debug(`[pipeline] ISS-${issue.id}: model "${preferredModel}" depleted on ${runnerName} until ${depletedUntil}, re-queuing`);
    await strapi.documents(SESSION_UID).update({
      documentId: session.documentId,
      data: { status: 'queued' } as any,
    });
    return;
  }
  const hasQuota = runnerId === '__legacy__'
    ? hasAnyQuota(preferredModel)
    : hasAnyQuotaForRunner(runnerId, preferredModel);

  if (!hasQuota) {
    strapi.log.warn(
      `[pipeline] ISS-${issue.id}: Antigravity quota depleted on ${runnerName} for ${preferredModel || 'all models'}, re-queuing`,
    );
    await strapi.documents(SESSION_UID).update({
      documentId: session.documentId,
      data: { status: 'queued' } as any,
    });
    return;
  }

  const resolvedModel = stepConfig.model || agConfig.antigravityModel || 'default';
  strapi.log.info(`[pipeline] ISS-${issue.id}: antigravity ${skill}, model=${resolvedModel}, runner=${runnerName}, projectId=${antigravityProjectId}`);

  try {
    await executeAntigravityStep(strapi, session, issue, _prompt, pipelineConfig, stepConfig, skill);
  } finally {
    try {
      const { dispatchNextForProject } = await import('./pipeline-orchestrator');
      await dispatchNextForProject(strapi, issue.project.documentId, 'antigravity');
    } catch (err: any) {
      strapi.log.warn(`[pipeline] Failed to dispatch next antigravity job: ${err.message}`);
    }
  }
}

export { findResumableSession };
