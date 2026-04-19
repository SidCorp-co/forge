import type { Context } from 'koa';
import { sendToDevice, sendToSession } from '../../../services/websocket';
import { getProjectDeviceId } from './project-utils';
import { findAvailableDevice, clearDeviceAllocation } from '../../../services/device-pool';
import { resolveRepoPath } from '../../../services/resolve-repo-path';
import { buildChatPreamble, TOOL_REFERENCE } from '../../../services/pipeline-preamble';

const UID = 'api::agent-session.agent-session' as any;

/** Returns false and sets 403 if a JWT user does not own the session. */
function checkSessionOwnership(ctx: Context, session: any): boolean {
  if (!ctx.state.user || ctx.state.forgeProject) return true;
  // Owner of the session
  if (session?.user?.id === ctx.state.user.id) return true;
  // Pipeline-created sessions have no user — allow if the user owns
  // the project's default device (the desktop that runs the CLI agent).
  if (!session?.user && session?.project?.defaultDevice?.user?.id === ctx.state.user.id) return true;
  ctx.status = 403;
  return false;
}

export async function start(ctx: Context, strapi: any) {
  const { projectSlug, prompt, repoPath, origin, preBuilt, issueIds, type: sessionType } = ctx.request.body as any;

  const isReindex = sessionType?.endsWith('-reindex');
  const isAgentSession = !!sessionType;

  if (!projectSlug || (!prompt && !isAgentSession)) {
    ctx.status = 400;
    return { error: 'projectSlug and prompt are required' };
  }

  // Find project by slug
  const projects = await strapi.documents('api::project.project').findMany({
    filters: { slug: { $eq: projectSlug } },
    populate: ['defaultDevice'],
    limit: 1,
  });
  const project = projects[0];
  if (!project) {
    ctx.status = 404;
    return { error: 'Project not found' };
  }

  // Try to find an available device from the pool, fall back to defaultDevice
  let deviceId: string | null = null;
  if (origin !== 'desktop') {
    deviceId = (await findAvailableDevice(project.documentId))?.deviceId ?? null;
  }
  if (!deviceId) {
    deviceId = (project as any).defaultDevice?.deviceId || null;
  }

  // For agent-type sessions, look up the agent record and its definition
  let agentConfig: any;
  if (isAgentSession) {
    const agentType = isReindex ? sessionType.replace(/-reindex$/, '') : sessionType;
    const agents = await strapi.documents('api::agent.agent').findMany({
      filters: { project: { documentId: { $eq: project.documentId } }, type: { $eq: agentType } },
      populate: { definition: true },
      limit: 1,
    });
    agentConfig = agents[0];
    if (!agentConfig?.enabled && !isReindex) {
      ctx.status = 400;
      return { error: 'Agent is not enabled for this project' };
    }
  }

  const agentName = agentConfig?.name || sessionType;
  const effectivePrompt = prompt || (isReindex ? `${agentName}: Knowledge Reindex` : `${agentName}: Review`);
  let cleanTitle: string;
  if (isAgentSession) {
    cleanTitle = isReindex ? `${agentName} Reindex` : `${agentName} Review`;
  } else if (issueIds?.length) {
    // Use issue titles for sessions triggered from issues
    const issues = await strapi.documents('api::issue.issue').findMany({
      filters: { documentId: { $in: issueIds } },
      fields: ['id', 'title'],
    });
    if (issues.length === 1) {
      cleanTitle = `ISS-${issues[0].id} ${issues[0].title}`.slice(0, 120);
    } else if (issues.length > 1) {
      cleanTitle = issues.map((i: any) => `ISS-${i.id}`).join(', ').slice(0, 120);
    } else {
      cleanTitle = effectivePrompt.slice(0, 120);
    }
  } else {
    cleanTitle = effectivePrompt
      .replace(/^You are working on issue:\s*/i, '')
      .replace(/^You are working on the following issues:\s*/i, '')
      .replace(/^You are working on:\s*/i, '')
      .slice(0, 120);
  }
  const now = Date.now();
  const messages = [{ role: 'user', content: effectivePrompt, timestamp: now }];

  const metadata: any = isAgentSession ? { type: sessionType } : {};
  if (deviceId) metadata.deviceId = deviceId;

  const rp = await resolveRepoPath(strapi, projectSlug, deviceId, repoPath, (project as any).repoPath);

  const sessionData: any = {
    title: cleanTitle,
    status: 'running',
    messages,
    project: project.documentId,
    repoPath: rp,
    metadata,
  };

  // Link to issues if issueIds provided
  if (issueIds?.length) {
    sessionData.issues = issueIds;
  }

  // Link session to authenticated user
  if (ctx.state.user) {
    sessionData.user = ctx.state.user.documentId;
  }

  // For issue-triggered sessions (non-agent-type), try to resume an existing
  // Claude CLI session so the agent retains context from previous interactions.
  if (!isAgentSession && issueIds?.length && origin !== 'desktop' && deviceId) {
    const existing = await findResumableSessionForIssue(strapi, issueIds[0], deviceId);
    if (existing) {
      // Resume: append prompt to existing session, send agent:send
      const messages = [...(existing.messages || []), { role: 'user', content: effectivePrompt, timestamp: Date.now() }];
      await strapi.documents(UID).update({
        documentId: existing.documentId,
        data: { status: 'running', messages, title: cleanTitle } as any,
      });
      setTimeout(() => {
        sendToDevice(deviceId, 'agent:send', {
          sessionId: existing.documentId,
          message: effectivePrompt,
          claudeSessionId: existing.claudeSessionId,
          repoPath: rp,
          projectSlug,
        });
      }, 500);
      ctx.status = 200;
      return { data: { ...existing, status: 'running', messages } };
    }
  }

  const session = await strapi.documents(UID).create({ data: sessionData });
  if (deviceId) clearDeviceAllocation(deviceId);

  const sid = session.documentId;

  // Notify web subscribers of the user message (for desktop-originated sessions)
  if (origin === 'desktop') {
    sendToSession(sid, 'agent:user-message', { sessionId: sid, content: effectivePrompt });
  }

  // Send agent command to project's default device
  if (origin !== 'desktop' && deviceId) {
    if (isAgentSession) {
      const agentEvent = isReindex ? 'agent:reindex' : 'agent:review';
      setTimeout(() => {
        sendToDevice(deviceId, agentEvent, { sessionId: sid, repoPath: rp, projectSlug, agentConfig });
      }, 500);
    } else {
      // Pre-fetch project context (knowledge + conventions) for new chats
      // so the agent has codebase orientation without extra tool calls.
      let enrichedPrompt = prompt;
      if (!preBuilt) {
        try {
          const preamble = await buildChatPreamble(strapi, project.documentId);
          enrichedPrompt = preamble + prompt;
        } catch { /* non-fatal — proceed with raw prompt */ }
      }
      setTimeout(() => {
        sendToDevice(deviceId, 'agent:start', { sessionId: sid, repoPath: rp, prompt: enrichedPrompt, projectSlug, preBuilt, systemPrompt: TOOL_REFERENCE });
      }, 500);
    }
  }

  ctx.status = 201;
  return { data: session };
}

export async function send(ctx: Context, strapi: any) {
  const { sessionId, message, claudeSessionId, origin } = ctx.request.body as any;

  if (!sessionId || !message) {
    ctx.status = 400;
    return { error: 'sessionId and message are required' };
  }

  const session: any = await strapi.documents(UID).findOne({
    documentId: sessionId,
    populate: ['user', 'project', 'project.defaultDevice', 'project.defaultDevice.user'],
  });
  if (!session) {
    ctx.status = 404;
    return { error: 'Session not found' };
  }

  if (!checkSessionOwnership(ctx, session)) {
    return { error: 'You can only send messages to your own sessions' };
  }

  // Append user message
  const messages = [...(session.messages || []), { role: 'user', content: message, timestamp: Date.now() }];
  await strapi.documents(UID).update({
    documentId: sessionId,
    data: { messages, status: 'running' } as any,
  });

  // Notify web subscribers of the user message (only for desktop-originated sends)
  if (origin === 'desktop') {
    sendToSession(sessionId, 'agent:user-message', { sessionId, content: message });
  }

  // Send to the device that started this session, fall back to project default
  if (origin !== 'desktop') {
    const ps = session.project?.slug || '';
    const deviceId = session.metadata?.deviceId || await getProjectDeviceId(strapi, ps);
    if (deviceId) {
      const rp = session.repoPath || '';
      const csid = claudeSessionId || session.claudeSessionId;
      setTimeout(() => {
        sendToDevice(deviceId, 'agent:send', { sessionId, message, claudeSessionId: csid, repoPath: rp, projectSlug: ps });
      }, 500);
    }
  }

  return { data: { ok: true } };
}

export async function abort(ctx: Context, strapi: any) {
  const { sessionId } = ctx.request.body as any;

  if (!sessionId) {
    ctx.status = 400;
    return { error: 'sessionId is required' };
  }

  const session: any = await strapi.documents(UID).findOne({
    documentId: sessionId,
    populate: ['user', 'project', 'project.defaultDevice', 'project.defaultDevice.user', 'issues'],
  });

  if (ctx.state.user && !ctx.state.forgeProject) {
    if (!checkSessionOwnership(ctx, session)) {
      return { error: 'You can only abort your own sessions' };
    }
  }

  await strapi.documents(UID).update({
    documentId: sessionId,
    data: { status: 'idle' } as any,
  });

  // Set manualHold on linked pipeline issues so heartbeat/pipeline won't auto-retry
  if (session?.metadata?.type === 'pipeline' && session?.issues?.length) {
    for (const issue of session.issues) {
      await strapi.documents('api::issue.issue' as any).update({
        documentId: issue.documentId,
        data: { manualHold: true },
      });
    }
  }

  const deviceId = session?.metadata?.deviceId || (session?.project?.slug ? await getProjectDeviceId(strapi, session.project.slug) : null);
  if (deviceId) {
    sendToDevice(deviceId, 'agent:abort', { sessionId });
  }

  return { data: { ok: true } };
}

/**
 * Max context tokens before a session is too large to resume.
 * Matches the pipeline threshold in pipeline-utils.ts.
 */
const MAX_RESUMABLE_CONTEXT = 600_000;

/**
 * Find the most recent completed/idle session for an issue that has a claudeSessionId.
 * Used to resume an existing Claude CLI conversation instead of starting a new one.
 * Only matches sessions from the same device — claudeSessionId is device-local.
 * Skips sessions whose context has grown beyond MAX_RESUMABLE_CONTEXT.
 */
async function findResumableSessionForIssue(strapi: any, issueDocumentId: string, deviceId?: string | null): Promise<any | null> {
  const sessions = await strapi.documents(UID).findMany({
    filters: {
      issues: { documentId: { $eq: issueDocumentId } },
      claudeSessionId: { $notNull: true },
      status: { $in: ['completed', 'idle'] },
    },
    sort: 'updatedAt:desc',
    limit: 5,
  });
  const match = sessions.find((s: any) => {
    if (!s.claudeSessionId) return false;
    if (deviceId && s.metadata?.deviceId !== deviceId) return false;
    if ((s.usage?.contextUsed || 0) > MAX_RESUMABLE_CONTEXT) return false;
    return true;
  });
  return match || null;
}
