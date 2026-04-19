import type { ForgeTool, ForgeToolContext } from './tools';
import { sendToDevice, sendToSession, isAnyDeviceConnected } from '../websocket';
import { findAvailableDevice, clearDeviceAllocation } from '../device-pool';
import * as antigravity from '../antigravity';
import { parseAntigravityResponse } from '../antigravity';
import { resolveRepoPath } from '../resolve-repo-path';

const SESSION_UID = 'api::agent-session.agent-session' as any;
const PROJECT_UID = 'api::project.project' as any;

/**
 * MCP tool: forge_claude
 *
 * Exposes the Claude proxy to any MCP-connected agent.
 * Supports both desktop (Claude CLI) and antigravity (server-side) runners.
 * External projects can run agents without any local setup — just send a prompt.
 *
 * Integration guide for other projects:
 *   1. Connect to Forge MCP server at <strapi-url>/mcp
 *   2. Set X-Forge-API-Key header (project API key)
 *   3. Call forge_claude with action "run" and a prompt
 *   4. Poll with action "status" until status is "completed"
 *   5. Read messages from the status response
 */
export const forgeClaude: ForgeTool = {
  name: 'forge_claude',
  description: 'Run Claude agent via desktop or Antigravity runner. Actions: run, status, resume. Use targetProjectSlug for cross-project runs.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['run', 'status', 'resume'],
        description: 'run: start new session. status: poll session. resume: continue existing session.',
      },
      prompt: {
        type: 'string',
        description: 'The prompt to send to the agent (required for run/resume)',
      },
      sessionId: {
        type: 'string',
        description: 'Session ID (required for status/resume)',
      },
      repoPath: {
        type: 'string',
        description: 'Working directory on the desktop device (optional — auto-resolved from project config)',
      },
      runner: {
        type: 'string',
        enum: ['desktop', 'antigravity'],
        description: 'Execution runner. desktop: Claude CLI on connected device. antigravity: server-side. Default: auto (desktop if available, antigravity fallback).',
      },
      targetProjectSlug: {
        type: 'string',
        description: 'Optional: run agent in context of a different project by slug (cross-project). Requires crossProjectAccess.',
      },
    },
    required: ['action'],
  },

  async execute(input: Record<string, unknown>, ctx: ForgeToolContext): Promise<string> {
    if (ctx.pipelineSkill) {
      return 'Error: forge_claude cannot be used by pipeline agents. Agent-to-agent delegation is not allowed.';
    }

    const action = input.action as string;
    const strapi = ctx.strapi;
    const docs = strapi.documents(SESSION_UID);
    const requestedRunner = input.runner as 'desktop' | 'antigravity' | undefined;

    if (action === 'status') {
      const sessionId = input.sessionId as string;
      if (!sessionId) return 'Error: sessionId required for status action';

      const session: any = await docs.findOne({ documentId: sessionId });
      if (!session) return 'Error: Session not found';

      // Antigravity poll-through: sync status from Antigravity if still running
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

            // Broadcast via WebSocket so the web UI sees the response
            sendToSession(sessionId, 'agent:message', {
              sessionId,
              type: 'text',
              content: response,
            });

            await docs.update({ documentId: sessionId, data: { status: 'completed', messages } as any });

            sendToSession(sessionId, 'agent:complete', { sessionId });

            return JSON.stringify({
              sessionId: session.documentId,
              status: 'completed',
              runner: 'antigravity',
              messageCount: messages.length,
              messages: messages.map((m: any) => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content.slice(0, 2000) : m.content,
                timestamp: m.timestamp,
              })),
            });
          }
          if (agStatus?.status === 'Failed') {
            sendToSession(sessionId, 'agent:message', {
              sessionId,
              type: 'error',
              content: agStatus.error || 'Antigravity execution failed',
            });

            await docs.update({ documentId: sessionId, data: { status: 'failed' } as any });

            sendToSession(sessionId, 'agent:complete', { sessionId });

            return JSON.stringify({
              sessionId: session.documentId,
              status: 'failed',
              runner: 'antigravity',
              error: agStatus.error || 'Antigravity execution failed',
            });
          }
          if (agStatus) {
            return JSON.stringify({
              sessionId: session.documentId,
              status: 'running',
              runner: 'antigravity',
              antigravityStatus: agStatus.status,
              messageCount: session.messages?.length ?? 0,
            });
          }
        }
      }

      const messages = Array.isArray(session.messages) ? session.messages.slice(-20) : [];
      return JSON.stringify({
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
      });
    }

    if (action === 'run' || action === 'resume') {
      const prompt = input.prompt as string;
      if (!prompt) return 'Error: prompt required for run/resume action';

      // Resolve cross-project access if targetProjectSlug is provided
      let targetProjectDocId = ctx.projectDocumentId;
      if (input.targetProjectSlug) {
        if (!ctx.crossProjectAccess) {
          return 'Error: crossProjectAccess required to run agents in other projects.';
        }
        const targetId = await resolveTargetProject(strapi, input.targetProjectSlug as string);
        if (!targetId) return `Error: project with slug "${input.targetProjectSlug}" not found`;
        targetProjectDocId = targetId;
      }

      // Resolve project
      const projects = await strapi.documents(PROJECT_UID).findMany({
        filters: { documentId: { $eq: targetProjectDocId } },
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';

      const inputRepoPath = (input.repoPath as string) || undefined;

      // Resume existing session
      if (action === 'resume') {
        const sessionId = input.sessionId as string;
        if (!sessionId) return 'Error: sessionId required for resume action';

        const existing: any = await docs.findOne({ documentId: sessionId });
        if (!existing) return 'Error: Session not found';

        // Antigravity sessions can't be resumed
        if (existing.metadata?.runner === 'antigravity') {
          return 'Error: Antigravity sessions cannot be resumed. Start a new session instead.';
        }

        // Find device for desktop resume (use target project for cross-project)
        let deviceId: string | null = (await findAvailableDevice(targetProjectDocId))?.deviceId ?? null;
        if (!deviceId && isAnyDeviceConnected()) deviceId = 'default';
        if (!deviceId) return 'Error: No desktop device available for resume.';

        const effectiveRepoPath = await resolveRepoPath(strapi, project.slug, deviceId, inputRepoPath, project.repoPath);

        const messages = [...(existing.messages || []), { role: 'user', content: prompt, timestamp: Date.now() }];
        await docs.update({
          documentId: sessionId,
          data: { messages, status: 'running' } as any,
        });

        sendToDevice(deviceId, 'agent:send', {
          sessionId,
          message: prompt,
          claudeSessionId: existing.claudeSessionId,
          repoPath: effectiveRepoPath,
          projectSlug: project.slug,
        });

        return JSON.stringify({
          sessionId,
          status: 'running',
          runner: 'desktop',
          message: 'Session resumed. Poll with action "status" to get results.',
        });
      }

      // New session — resolve runner (use target project for cross-project device lookup)
      const resolvedRunner = await resolveRunnerForMCP(requestedRunner, project, targetProjectDocId);
      if (resolvedRunner.error) return `Error: ${resolvedRunner.error}`;

      // Antigravity path
      if (resolvedRunner.runner === 'antigravity') {
        const agProjectId = project.antigravityProjectId;
        const effectiveRepoPath = await resolveRepoPath(strapi, project.slug, null, inputRepoPath, project.repoPath);
        const { requestId } = await antigravity.chatAsync({
          projectId: agProjectId,
          message: prompt,
          newSession: true,
        });

        const sessionData: any = {
          title: prompt.slice(0, 120),
          status: 'running',
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
          project: project.documentId,
          repoPath: effectiveRepoPath,
          metadata: {
            origin: 'mcp-tool',
            runner: 'antigravity',
            antigravityRequestId: requestId,
            antigravityProjectId: agProjectId,
          },
        };

        const session = await docs.create({ data: sessionData });
        return JSON.stringify({
          sessionId: session.documentId,
          status: 'running',
          runner: 'antigravity',
          message: 'Antigravity session started. Poll with action "status" to get results.',
        });
      }

      // Desktop path
      const deviceId = resolvedRunner.device!;
      const effectiveRepoPath = await resolveRepoPath(strapi, project.slug, deviceId, inputRepoPath, project.repoPath);
      const sessionData: any = {
        title: prompt.slice(0, 120),
        status: 'running',
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        project: project.documentId,
        repoPath: effectiveRepoPath,
        metadata: { origin: 'mcp-tool', runner: 'desktop', deviceId },
      };

      const session = await docs.create({ data: sessionData });
      if (deviceId !== 'default') clearDeviceAllocation(deviceId);

      setTimeout(() => {
        sendToDevice(deviceId!, 'agent:start', {
          sessionId: session.documentId,
          repoPath: effectiveRepoPath,
          prompt,
          projectSlug: project.slug,
          projectDocumentId: project.documentId,
        });
      }, 500);

      return JSON.stringify({
        sessionId: session.documentId,
        status: 'running',
        runner: 'desktop',
        message: 'Claude CLI session started on desktop device. Poll with action "status" to get results.',
      });
    }

    return `Unknown action: ${action}. Use run, status, or resume.`;
  },
};

/** Resolve a target project by slug. Returns the project documentId or null. */
async function resolveTargetProject(strapi: any, slug: string): Promise<string | null> {
  const project = await strapi.documents(PROJECT_UID).findFirst({
    filters: { slug: { $eq: slug } },
  });
  return project?.documentId || null;
}

/**
 * Resolve runner for MCP tool context. Same logic as run.ts resolveRunner
 * but returns a simpler structure.
 */
async function resolveRunnerForMCP(
  runner: 'desktop' | 'antigravity' | undefined,
  project: any,
  projectDocumentId: string,
): Promise<{ runner: 'desktop' | 'antigravity'; device: string | null; error?: string }> {
  if (runner === 'antigravity') {
    if (!project?.antigravityProjectId) {
      return { runner: 'antigravity', device: null, error: 'Project has no Antigravity configuration' };
    }
    return { runner: 'antigravity', device: null };
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

  if (project?.antigravityProjectId) {
    return { runner: 'antigravity', device: null };
  }

  return { runner: 'desktop', device: null, error: 'No desktop device or Antigravity runner available' };
}
