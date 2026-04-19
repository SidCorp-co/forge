import type { Context } from 'koa';
import { broadcast, sendToDevice, sendToSession, registerDevice, unregisterDevice, isDeviceConnected, isAnyDeviceConnected } from '../../../services/websocket';
import { sessionStreams, accumulateMessage, sanitizeForDb } from '../services/stream-accumulator';
import { upsertAssistantMessage } from '../services/message-utils';
import { getProjectDeviceId } from './project-utils';
import { findAvailableDevice } from '../../../services/device-pool';
import { onSessionComplete } from '../../../services/pipeline-orchestrator';
import { resolveRepoPath } from '../../../services/resolve-repo-path';
import { needsSkillSync } from '../../../services/antigravity';

const UID = 'api::agent-session.agent-session' as any;
const PROJECT_UID = 'api::project.project' as any;

export async function relay(ctx: Context, strapi: any) {
  const { id } = ctx.params;
  const { event, data } = ctx.request.body as any;

  if (event === 'agent:batch') {
    // Batched messages from desktop — relay each to web clients + accumulate
    const items = data?.items || [];
    strapi.log.debug(`[relay] agent:batch sid=${id.slice(0,8)} items=${items.length}`);
    for (const item of items) {
      if (item.event === 'agent:message') {
        sendToSession(id, 'agent:message', { sessionId: id, ...item.data });
        accumulateMessage(strapi, id, item.data, UID);
      }
    }
  } else if (event === 'agent:message') {
    // Single message relay + accumulate
    sendToSession(id, 'agent:message', { sessionId: id, ...data });
    accumulateMessage(strapi, id, data, UID);
  } else if (event === 'agent:complete') {
    // Final flush: cancel pending timer and persist accumulated content
    const stream = sessionStreams.get(id);
    strapi.log.debug(`[relay] agent:complete sid=${id.slice(0,8)} accumTextLen=${stream?.text?.length || 0} toolCalls=${stream?.toolCalls?.length || 0}`);
    if (stream?.flushTimer) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = null;
    }

    const session: any = await strapi.documents(UID).findOne({ documentId: id, populate: ['project', 'issues'] });
    if (session) {
      const fullText = stream?.text || data?.fullMessage || '';
      const toolCalls = stream?.toolCalls?.length ? stream.toolCalls : data?.toolCalls;
      const contentBlocks = stream?.contentBlocks?.length ? stream.contentBlocks : undefined;
      const claudeSessionId = stream?.claudeSessionId || data?.claudeSessionId;

      const messages = [...(session.messages as any[] || [])];
      upsertAssistantMessage(messages, fullText, toolCalls, contentBlocks);

      // Detect usage limit errors BEFORE recovery — disable device to prevent retry loops.
      // isUsageLimitError uses strict pattern matching (requires "resets Xam (tz)")
      // to avoid false positives from agent responses that merely discuss limits.
      if (data?.error || fullText) {
        const { handleUsageLimitIfPresent } = await import('../../../services/pipeline-utils');
        await handleUsageLimitIfPresent(strapi, session.metadata?.deviceId, data?.error, fullText);
      }

      // For pipeline sessions that report an error, check if the agent already
      // advanced the issue before crashing — if so, mark completed instead of failed.
      // Combine data.error with fullText so recoverOrFailSession can detect usage/env errors in the stream.
      if (data?.error && session.metadata?.type === 'pipeline') {
        const { recoverOrFailSession } = await import('../../../services/pipeline-utils');
        const combinedError = fullText ? `${data.error} | ${fullText.slice(0, 500)}` : data.error;
        // Pass accumulated messages so recovery persists the agent's final response
        const sessionWithMessages = { ...session, messages: sanitizeForDb(messages) };
        await recoverOrFailSession(strapi, sessionWithMessages, combinedError, { tag: 'desktop-relay', autoRetry: true });
        // recoverOrFailSession already updated status + messages — persist remaining fields
        const extraData: any = {};
        // Skip persisting claudeSessionId when the CLI session no longer exists —
        // recoverOrFailSession already cleared it + set noResume to break the retry loop.
        const isSessionGone = /no conversation found with session id/i.test(combinedError);
        if (claudeSessionId && !isSessionGone) extraData.claudeSessionId = claudeSessionId;
        if (stream?.usage && stream.usage.turns > 0) extraData.usage = stream.usage;
        if (data?.diff) extraData.diff = sanitizeForDb(data.diff);
        if (Object.keys(extraData).length > 0) {
          await strapi.documents(UID).update({ documentId: id, data: extraData });
        }
      } else {
        const status = data?.error ? 'failed' : 'completed';
        const updateData: any = { status, messages: sanitizeForDb(messages) };
        if (claudeSessionId) updateData.claudeSessionId = claudeSessionId;
        if (stream?.usage && stream.usage.turns > 0) updateData.usage = stream.usage;
        if (data?.diff) updateData.diff = sanitizeForDb(data.diff);

        await strapi.documents(UID).update({ documentId: id, data: updateData });
      }

      // Set knowledgeIndexedAt when an index-codebase session completes successfully
      if (!data?.error && session.metadata?.type === 'index-codebase') {
        const projectDocId = typeof session.project === 'string' ? session.project : session.project?.documentId;
        if (projectDocId) {
          await strapi.documents(PROJECT_UID).update({
            documentId: projectDocId,
            data: { knowledgeIndexedAt: new Date().toISOString() },
          });
        }
      }
    }

    // Clean up accumulator
    sessionStreams.delete(id);

    // Relay completion to web UI subscribers.
    // For pipeline sessions recovered by verification, strip the error flag
    // so the UI doesn't show a false failure state on a completed session.
    const completePayload = { sessionId: id, ...data };
    if (data?.error && session?.metadata?.type === 'pipeline') {
      // Re-read session to get the actual status after recoverOrFailSession
      const updated = await strapi.documents(UID).findOne({ documentId: id });
      if (updated?.status === 'completed') {
        delete completePayload.error;
      }
    }
    sendToSession(id, 'agent:complete', completePayload);

    // Dispatch queued pipeline step if one is waiting for this session
    setImmediate(() => onSessionComplete(strapi, id));
  }

  return { data: { ok: true } };
}

export async function buildPrompt(ctx: Context, strapi: any) {
  const { projectSlug, issueIds } = ctx.request.body as any;

  if (!projectSlug || !issueIds?.length) {
    ctx.status = 400;
    return { error: 'projectSlug and issueIds are required' };
  }

  // Try pool allocation first, fall back to default device
  const projects = await strapi.documents('api::project.project').findMany({
    filters: { slug: { $eq: projectSlug } },
    limit: 1,
  });
  const deviceId = (projects[0] ? (await findAvailableDevice(projects[0].documentId))?.deviceId : null)
    || await getProjectDeviceId(strapi, projectSlug);
  if (!deviceId || !isDeviceConnected(deviceId)) {
    ctx.status = 503;
    return { error: 'No device connected for this project' };
  }

  const requestId = crypto.randomUUID();
  strapi.log.debug(`[build-prompt] sending to device ${deviceId}: requestId=${requestId} projectSlug=${projectSlug} issueIds=${issueIds}`);
  sendToDevice(deviceId, 'agent:build-prompt', { requestId, projectSlug, issueIds });

  return { data: { requestId } };
}

export async function promptBuilt(ctx: Context, strapi: any) {
  const { requestId, prompt, error: buildError } = ctx.request.body as any;

  if (!requestId || (!prompt && !buildError)) {
    ctx.status = 400;
    return { error: 'requestId and (prompt or error) are required' };
  }

  strapi.log.debug(`[prompt-built] relaying: requestId=${requestId} hasPrompt=${!!prompt} error=${buildError || 'none'}`);
  broadcast('agent:prompt-built', { requestId, prompt, error: buildError });
  return { data: { ok: true } };
}

export async function registerDeviceHandler(ctx: Context) {
  const { deviceId } = ctx.request.body as any;
  if (!deviceId) {
    ctx.status = 400;
    return { error: 'deviceId is required' };
  }
  registerDevice(deviceId);
  return { data: { ok: true } };
}

export async function unregisterDeviceHandler(ctx: Context) {
  const { deviceId } = ctx.request.body as any;
  if (!deviceId) {
    ctx.status = 400;
    return { error: 'deviceId is required' };
  }
  unregisterDevice(deviceId);
  return { data: { ok: true } };
}

export async function deviceStatus(ctx: Context, strapi: any) {
  let deviceId = (ctx.query as any).deviceId;

  if (!deviceId) {
    const projectSlug = (ctx.query as any).projectSlug;
    if (projectSlug) {
      // Check defaultDevice first
      deviceId = await getProjectDeviceId(strapi, projectSlug);

      // If no defaultDevice or it's not connected, check pool devices
      if (!deviceId || !isDeviceConnected(deviceId)) {
        const projects = await strapi.documents('api::project.project').findMany({
          filters: { slug: { $eq: projectSlug } },
          populate: ['devices'],
          limit: 1,
        });
        const poolDevices: any[] = projects[0]?.devices || [];
        for (const d of poolDevices) {
          if (d.deviceId && isDeviceConnected(d.deviceId)) {
            return { data: { connected: true } };
          }
        }
        // Last resort: check if any device is connected at all
        if (isAnyDeviceConnected()) {
          return { data: { connected: true } };
        }
      }
    }
  }

  if (!deviceId) {
    return { data: { connected: false } };
  }
  return { data: { connected: isDeviceConnected(deviceId) } };
}

export async function indexCodebase(ctx: Context, strapi: any) {
  const { projectDocumentId } = ctx.request.body as any;

  if (!projectDocumentId) {
    ctx.status = 400;
    return { error: 'projectDocumentId is required' };
  }

  const project: any = await strapi.documents(PROJECT_UID).findOne({
    documentId: projectDocumentId,
    populate: ['defaultDevice'],
  });

  if (!project) {
    ctx.status = 404;
    return { error: 'Project not found' };
  }

  // Find a connected desktop device
  const deviceId = (await findAvailableDevice(projectDocumentId))?.deviceId
    || project.defaultDevice?.deviceId
    || null;

  if (!deviceId || !isDeviceConnected(deviceId)) {
    ctx.status = 503;
    return { error: 'No desktop device connected. Connect a device in Settings → Integrations.' };
  }

  // Prevent concurrent indexing
  const existing = await strapi.documents(UID).findMany({
    filters: {
      project: { documentId: projectDocumentId },
      status: 'running',
    },
    limit: 10,
  });
  const runningIndex = existing.find((s: any) => s.metadata?.type === 'index-codebase');
  if (runningIndex) {
    return { data: { sessionId: runningIndex.documentId, alreadyRunning: true } };
  }

  const repoPath = await resolveRepoPath(strapi, project.slug, deviceId, undefined, project.repoPath);
  const baseBranch = project.baseBranch || 'master';
  const prompt = `/forge-index ${baseBranch}`;

  // Sync skills to device so forge-index is available in .claude/skills/
  try {
    if (await needsSkillSync(strapi, projectDocumentId)) {
      const SKILL_UID = 'api::skill.skill' as any;
      const skills = await strapi.documents(SKILL_UID).findMany({
        filters: { $or: [{ isGlobal: true }, { project: { documentId: projectDocumentId } }] },
        fields: ['name', 'description', 'version', 'skillMd', 'files', 'target', 'contentHash', 'localGuide'],
        limit: 100,
      });
      if (skills.length) {
        const payload = (skills as any[]).map((s) => ({
          name: s.name, description: s.description || '', version: s.version || '1.0.0',
          skillMd: s.target === 'dev' ? s.skillMd : undefined,
          localGuide: s.localGuide || undefined,
          target: s.target || 'dev', contentHash: s.contentHash || '',
          files: s.target === 'dev' ? (s.files || []) : [],
        }));
        sendToDevice(deviceId, 'skills:push', { skills: payload });
        await strapi.documents(PROJECT_UID).update({
          documentId: projectDocumentId,
          data: { skillsSyncedAt: new Date().toISOString() },
        });
      }
    }
  } catch (err: any) {
    strapi.log.warn(`[index-codebase] skill sync failed (non-fatal): ${err.message}`);
  }

  const session = await strapi.documents(UID).create({
    data: {
      title: `Index Codebase: ${project.slug}`,
      status: 'running',
      project: projectDocumentId,
      repoPath,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      metadata: { type: 'index-codebase', deviceId },
    },
  });

  sendToDevice(deviceId, 'agent:start', {
    sessionId: session.documentId,
    repoPath,
    prompt,
    projectSlug: project.slug,
    preBuilt: true,
  });

  strapi.log.info(`[index-codebase] Started for project ${project.slug}, session=${session.documentId}, device=${deviceId}`);

  return { data: { sessionId: session.documentId } };
}

