/**
 * Claude Proxy REST controller.
 * Exposes the runner proxy as HTTP API so external projects can run agents
 * without needing MCP protocol — just plain REST calls with API key auth.
 */
import * as antigravity from '../../../services/antigravity';
import { parseAntigravityResponse } from '../../../services/antigravity';
import { sendToDevice, isAnyDeviceConnected } from '../../../services/websocket';
import { findAvailableDevice, clearDeviceAllocation } from '../../../services/device-pool';
import { findAvailableRunner, clearRunnerAllocation } from '../../../services/antigravity-runner-pool';
import { resolveRepoPath } from '../../../services/resolve-repo-path';

const SESSION_UID = 'api::agent-session.agent-session' as any;
const PROJECT_UID = 'api::project.project' as any;

interface RunnerResolution {
  runner: 'desktop' | 'antigravity';
  device: string | null;
  /** Runner pool allocation (antigravity only). */
  antigravityProjectId?: string;
  runnerId?: string;
  agentId?: string;
  error?: string;
}

async function resolveRunner(
  runner: string | undefined,
  _project: any,
  projectDocumentId: string,
): Promise<RunnerResolution> {
  if (runner === 'antigravity') {
    // Try runner pool first, fall back to legacy
    const allocation = await findAvailableRunner(projectDocumentId);
    if (allocation) {
      if (allocation.runnerId !== '__legacy__') clearRunnerAllocation(allocation.runnerId);
      return {
        runner: 'antigravity', device: null,
        antigravityProjectId: allocation.antigravityProjectId,
        runnerId: allocation.runnerId,
        agentId: allocation.agentId,
      };
    }
    return { runner: 'antigravity', device: null, error: 'No Antigravity runner available' };
  }

  if (runner === 'desktop') {
    let deviceId: string | null = (await findAvailableDevice(projectDocumentId))?.deviceId ?? null;
    if (!deviceId && isAnyDeviceConnected()) deviceId = 'default';
    if (!deviceId) return { runner: 'desktop', device: null, error: 'No desktop device available' };
    return { runner: 'desktop', device: deviceId };
  }

  // Auto: try desktop first, fall back to antigravity
  let deviceId: string | null = (await findAvailableDevice(projectDocumentId))?.deviceId ?? null;
  if (!deviceId && isAnyDeviceConnected()) deviceId = 'default';
  if (deviceId) return { runner: 'desktop', device: deviceId };

  const allocation = await findAvailableRunner(projectDocumentId);
  if (allocation) {
    if (allocation.runnerId !== '__legacy__') clearRunnerAllocation(allocation.runnerId);
    return {
      runner: 'antigravity', device: null,
      antigravityProjectId: allocation.antigravityProjectId,
      runnerId: allocation.runnerId,
    };
  }

  return { runner: 'desktop', device: null, error: 'No desktop device or Antigravity runner available' };
}

function resolveProject(ctx: any) {
  return ctx.state.forgeProject || null;
}

export default {
  /**
   * POST /api/claude-proxy/run
   * Start a new agent session on desktop or Antigravity.
   */
  async run(ctx: any) {
    const { prompt, runner, repoPath } = ctx.request.body || {};
    if (!prompt) return ctx.badRequest('prompt is required');

    const forgeProject = resolveProject(ctx);
    if (!forgeProject) return ctx.badRequest('API key must map to a project');

    const project = await strapi.documents(PROJECT_UID).findOne({
      documentId: forgeProject.documentId,
    }) as any;
    if (!project) return ctx.badRequest('Project not found');

    const resolved = await resolveRunner(runner, project, project.documentId);
    if (resolved.error) {
      ctx.status = 503;
      ctx.body = { error: resolved.error };
      return;
    }

    const docs = strapi.documents(SESSION_UID);
    const inputRepoPath = repoPath || undefined;

    if (resolved.runner === 'antigravity') {
      const agProjectId = resolved.antigravityProjectId!;
      const effectiveRepoPath = await resolveRepoPath(strapi, project.slug, null, inputRepoPath, project.repoPath);
      const { requestId } = await antigravity.chatAsync({
        projectId: agProjectId,
        message: prompt,
        newSession: true,
      });

      const session = await docs.create({
        data: {
          title: prompt.slice(0, 120),
          status: 'running',
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
          project: project.documentId,
          repoPath: effectiveRepoPath,
          metadata: {
            origin: 'rest-api',
            runner: 'antigravity',
            antigravityRequestId: requestId,
            antigravityProjectId: agProjectId,
            antigravityRunnerId: resolved.runnerId,
            antigravityRunnerAgentId: resolved.agentId,
          },
        } as any,
      });

      ctx.body = { data: { sessionId: session.documentId, status: 'running', runner: 'antigravity' } };
      return;
    }

    // Desktop path
    const deviceId = resolved.device!;
    const effectiveRepoPath = await resolveRepoPath(strapi, project.slug, deviceId, inputRepoPath, project.repoPath);
    const session = await docs.create({
      data: {
        title: prompt.slice(0, 120),
        status: 'running',
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        project: project.documentId,
        repoPath: effectiveRepoPath,
        metadata: { origin: 'rest-api', runner: 'desktop', deviceId },
      } as any,
    });

    if (deviceId !== 'default') clearDeviceAllocation(deviceId);

    setTimeout(() => {
      sendToDevice(deviceId, 'agent:start', {
        sessionId: session.documentId,
        repoPath: effectiveRepoPath,
        prompt,
        projectSlug: project.slug,
        projectDocumentId: project.documentId,
      });
    }, 500);

    ctx.body = { data: { sessionId: session.documentId, status: 'running', runner: 'desktop' } };
  },

  /**
   * GET /api/claude-proxy/status/:sessionId
   * Poll session for results.
   */
  async status(ctx: any) {
    const { sessionId } = ctx.params;
    if (!sessionId) return ctx.badRequest('sessionId is required');

    const docs = strapi.documents(SESSION_UID);
    const session: any = await docs.findOne({ documentId: sessionId });
    if (!session) return ctx.notFound('Session not found');

    // Antigravity poll-through
    if (session.metadata?.runner === 'antigravity' && session.status === 'running') {
      const requestId = session.metadata?.antigravityRequestId;
      if (requestId) {
        const agStatus = await antigravity.chatStatus(requestId).catch(() => null);

        if (agStatus?.status === 'Completed') {
          const response = parseAntigravityResponse(agStatus.result?.response || '');
          const userMsg = session.messages?.[0];
          const messages = [
            ...(userMsg ? [userMsg] : []),
            { role: 'assistant', content: response, timestamp: Date.now() },
          ];
          await docs.update({ documentId: sessionId, data: { status: 'completed', messages } as any });

          ctx.body = {
            data: {
              sessionId, status: 'completed', runner: 'antigravity',
              messages: messages.map((m: any) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
            },
          };
          return;
        }

        if (agStatus?.status === 'Failed') {
          await docs.update({ documentId: sessionId, data: { status: 'failed' } as any });
          ctx.body = { data: { sessionId, status: 'failed', runner: 'antigravity', error: agStatus.error || 'Execution failed' } };
          return;
        }

        if (agStatus) {
          ctx.body = { data: { sessionId, status: 'running', runner: 'antigravity', antigravityStatus: agStatus.status } };
          return;
        }
      }
    }

    const messages = Array.isArray(session.messages) ? session.messages.slice(-20) : [];
    ctx.body = {
      data: {
        sessionId: session.documentId,
        status: session.status,
        runner: session.metadata?.runner || 'desktop',
        claudeSessionId: session.claudeSessionId || null,
        messageCount: session.messages?.length ?? 0,
        messages: messages.map((m: any) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content.slice(0, 2000) : m.content,
          timestamp: m.timestamp,
        })),
      },
    };
  },

  /**
   * POST /api/claude-proxy/resume
   * Continue an existing desktop session with a new prompt.
   */
  async resume(ctx: any) {
    const { sessionId, prompt } = ctx.request.body || {};
    if (!sessionId) return ctx.badRequest('sessionId is required');
    if (!prompt) return ctx.badRequest('prompt is required');

    const forgeProject = resolveProject(ctx);
    if (!forgeProject) return ctx.badRequest('API key must map to a project');

    const project = await strapi.documents(PROJECT_UID).findOne({
      documentId: forgeProject.documentId,
    }) as any;
    if (!project) return ctx.badRequest('Project not found');

    const docs = strapi.documents(SESSION_UID);
    const existing: any = await docs.findOne({ documentId: sessionId });
    if (!existing) return ctx.notFound('Session not found');

    if (existing.metadata?.runner === 'antigravity') {
      return ctx.badRequest('Antigravity sessions cannot be resumed. Start a new session instead.');
    }

    let deviceId: string | null = (await findAvailableDevice(project.documentId))?.deviceId ?? null;
    if (!deviceId && isAnyDeviceConnected()) deviceId = 'default';
    if (!deviceId) {
      ctx.status = 503;
      ctx.body = { error: 'No desktop device available for resume' };
      return;
    }

    const effectiveRepoPath = await resolveRepoPath(strapi, project.slug, deviceId, undefined, project.repoPath);
    const messages = [...(existing.messages || []), { role: 'user', content: prompt, timestamp: Date.now() }];
    await docs.update({ documentId: sessionId, data: { messages, status: 'running' } as any });

    sendToDevice(deviceId, 'agent:send', {
      sessionId,
      message: prompt,
      claudeSessionId: existing.claudeSessionId,
      repoPath: effectiveRepoPath,
      projectSlug: project.slug,
    });

    ctx.body = { data: { sessionId, status: 'running', runner: 'desktop' } };
  },
};
