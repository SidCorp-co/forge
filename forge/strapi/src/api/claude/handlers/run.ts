import type { Context } from 'koa';
import { sendToDevice, sendToSession } from '../../../services/websocket';
import { findAvailableDevice, clearDeviceAllocation } from '../../../services/device-pool';
import { isDeviceConnected, isAnyDeviceConnected } from '../../../services/websocket';
import { startSSEStream } from '../../../services/sse-bridge';
import * as antigravity from '../../../services/antigravity';
import { parseAntigravityResponse } from '../../../services/antigravity';
import { resolveRepoPath } from '../../../services/resolve-repo-path';
import { findAvailableRunner } from '../../../services/antigravity-runner-pool';

const UID = 'api::agent-session.agent-session' as any;
/** How often to poll Antigravity for async results (ms). */
const AG_POLL_INTERVAL = 3000;
/** Max time to wait for Antigravity before giving up (ms). */
const AG_POLL_TIMEOUT = 30 * 60 * 1000;

type Runner = 'desktop' | 'antigravity';

interface RunBody {
  prompt: string;
  repoPath?: string;
  deviceId?: string;
  sessionId?: string;
  stream?: boolean;
  runner?: Runner;
}

/**
 * Find a device for the claude proxy. Uses the project's device pool if a project
 * is available, otherwise falls back to checking if a specific deviceId or any device
 * is connected.
 */
async function resolveDevice(projectDocId?: string, deviceId?: string): Promise<string | null> {
  // If caller specified a device, check it's connected
  if (deviceId) {
    return isDeviceConnected(deviceId) ? deviceId : null;
  }
  // If we have a project, use the device pool
  if (projectDocId) {
    return (await findAvailableDevice(projectDocId))?.deviceId ?? null;
  }
  // No project context — can't use pool, just check any device
  return isAnyDeviceConnected() ? 'default' : null;
}

/**
 * Resolve which runner to use based on explicit choice or auto-detection.
 * Returns the runner type and device ID (null for antigravity).
 */
interface RunnerResolution {
  runner: Runner;
  device: string | null;
  /** For antigravity: the resolved runner allocation */
  antigravityAllocation?: { antigravityProjectId: string; runnerId: string; agentId?: string };
  error?: string;
  status?: number;
}

async function resolveRunner(
  runner: Runner | undefined,
  project: any,
  deviceId?: string,
): Promise<RunnerResolution> {
  if (runner === 'antigravity') {
    // Try runner pool first, fall back to legacy
    if (project?.documentId) {
      const allocation = await findAvailableRunner(project.documentId);
      if (allocation) {
        return {
          runner: 'antigravity',
          device: null,
          antigravityAllocation: {
            antigravityProjectId: allocation.antigravityProjectId,
            runnerId: allocation.runnerId,
          },
        };
      }
    }
    // Legacy fallback
    const agProjectId = project?.antigravityProjectId;
    if (!agProjectId) {
      return { runner: 'antigravity', device: null, error: 'Project has no Antigravity configuration', status: 400 };
    }
    return {
      runner: 'antigravity',
      device: null,
      antigravityAllocation: { antigravityProjectId: agProjectId, runnerId: '__legacy__' },
    };
  }

  if (runner === 'desktop') {
    const device = await resolveDevice(project?.documentId, deviceId);
    if (!device) {
      return { runner: 'desktop', device: null, error: 'No desktop device available', status: 503 };
    }
    return { runner: 'desktop', device };
  }

  // Auto: try desktop first, fall back to antigravity
  const device = await resolveDevice(project?.documentId, deviceId);
  if (device) {
    return { runner: 'desktop', device };
  }

  // Try runner pool
  if (project?.documentId) {
    const allocation = await findAvailableRunner(project.documentId);
    if (allocation) {
      return {
        runner: 'antigravity',
        device: null,
        antigravityAllocation: {
          antigravityProjectId: allocation.antigravityProjectId,
          runnerId: allocation.runnerId,
          agentId: allocation.agentId,
        },
      };
    }
  }

  // Legacy fallback
  const agProjectId = project?.antigravityProjectId;
  if (agProjectId) {
    return {
      runner: 'antigravity',
      device: null,
      antigravityAllocation: { antigravityProjectId: agProjectId, runnerId: '__legacy__' },
    };
  }

  return { runner: 'desktop', device: null, error: 'No desktop device or Antigravity runner available', status: 503 };
}

/**
 * Start an antigravity session: fire async chat request, create agent session,
 * optionally stream results via SSE polling.
 */
async function runAntigravity(
  ctx: Context,
  strapi: any,
  project: any,
  prompt: string,
  effectiveRepoPath: string,
  stream: boolean,
  allocation?: { antigravityProjectId: string; runnerId: string; agentId?: string },
) {
  const agProjectId = allocation?.antigravityProjectId || project.antigravityProjectId;

  // Fire async request to Antigravity
  const { requestId } = await antigravity.chatAsync({
    projectId: agProjectId,
    message: prompt,
    newSession: true,
  });

  const now = Date.now();
  const sessionData: any = {
    title: prompt.slice(0, 120),
    status: 'running',
    messages: [{ role: 'user', content: prompt, timestamp: now }],
    repoPath: effectiveRepoPath,
    metadata: {
      origin: 'claude-proxy',
      runner: 'antigravity',
      antigravityRequestId: requestId,
      antigravityProjectId: agProjectId,
      antigravityRunnerId: allocation?.runnerId,
      antigravityRunnerAgentId: allocation?.agentId,
    },
  };
  if (project) sessionData.project = project.documentId;

  const session = await strapi.documents(UID).create({ data: sessionData });
  const sid = session.documentId;

  if (!stream) {
    ctx.status = 201;
    return { data: { sessionId: sid, status: 'running', runner: 'antigravity' } };
  }

  // SSE mode: set up stream then poll Antigravity until complete
  ctx.set('Content-Type', 'text/event-stream');
  ctx.set('Cache-Control', 'no-cache');
  ctx.set('Connection', 'keep-alive');
  ctx.set('X-Accel-Buffering', 'no');
  ctx.status = 200;
  ctx.respond = false;

  const res = ctx.res;
  res.write(': connected\n\n');
  res.write(`event: session\ndata: ${JSON.stringify({ sessionId: sid, runner: 'antigravity' })}\n\n`);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(': heartbeat\n\n');
    }
  }, 15_000);

  // Poll loop in background — don't block the response
  (async () => {
    const startTime = Date.now();
    let lastStatus = '';

    try {
      while (Date.now() - startTime < AG_POLL_TIMEOUT) {
        if (res.writableEnded || res.destroyed) break;

        await new Promise((r) => setTimeout(r, AG_POLL_INTERVAL));

        const result = await antigravity.chatStatus(requestId).catch(() => null);
        if (!result) continue; // Retry on transient errors

        // Emit status change events
        if (result.status !== lastStatus) {
          lastStatus = result.status;
          if (!res.writableEnded && !res.destroyed) {
            res.write(`event: message\ndata: ${JSON.stringify({ type: 'status', status: result.status })}\n\n`);
          }
        }

        if (result.status === 'Completed') {
          const response = parseAntigravityResponse(result.result?.response || '');
          // Preserve original user message from session, append assistant response
          const current: any = await strapi.documents(UID).findOne({ documentId: sid });
          const messages = [
            ...(current?.messages || [{ role: 'user', content: prompt, timestamp: now }]),
            { role: 'assistant', content: response, timestamp: Date.now() },
          ];

          // Broadcast via WebSocket so the web UI sees the response
          sendToSession(sid, 'agent:message', {
            sessionId: sid,
            type: 'text',
            content: response,
          });

          await strapi.documents(UID).update({
            documentId: sid,
            data: { status: 'completed', messages } as any,
          });

          sendToSession(sid, 'agent:complete', { sessionId: sid });

          if (!res.writableEnded && !res.destroyed) {
            res.write(`event: message\ndata: ${JSON.stringify({ type: 'text', content: response })}\n\n`);
            res.write(`event: complete\ndata: ${JSON.stringify({ sessionId: sid })}\n\n`);
          }
          break;
        }

        if (result.status === 'Failed') {
          const errorMsg = result.error || 'Antigravity execution failed';
          const currentSession: any = await strapi.documents(UID).findOne({ documentId: sid });

          sendToSession(sid, 'agent:message', {
            sessionId: sid,
            type: 'error',
            content: errorMsg,
          });

          await strapi.documents(UID).update({
            documentId: sid,
            data: { status: 'failed', metadata: { ...(currentSession?.metadata || {}), error: errorMsg } } as any,
          });

          sendToSession(sid, 'agent:complete', { sessionId: sid });

          if (!res.writableEnded && !res.destroyed) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`);
          }
          break;
        }
      }
    } catch (err: any) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded && !res.destroyed) {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  })();
}

export async function run(ctx: Context) {
  const strapi = globalThis.strapi;
  const { prompt, repoPath, deviceId, sessionId: resumeSessionId, stream = true, runner: requestedRunner } = ctx.request.body as RunBody;

  if (!prompt) {
    ctx.status = 400;
    return { error: 'prompt is required' };
  }

  // Project from is-forge-project policy (API key auth sets this)
  const project = (ctx.state as any).forgeProject;

  const projectSlug = project?.slug || '';

  // Resume existing session
  if (resumeSessionId) {
    const existing: any = await strapi.documents(UID).findOne({ documentId: resumeSessionId });
    if (!existing) {
      ctx.status = 404;
      return { error: 'Session not found' };
    }

    // Antigravity sessions can't be resumed (stateless)
    if (existing.metadata?.runner === 'antigravity') {
      ctx.status = 400;
      return { error: 'Antigravity sessions cannot be resumed. Start a new session instead.' };
    }

    const device = await resolveDevice(project?.documentId, deviceId);
    if (!device) {
      ctx.status = 503;
      return { error: 'No desktop device available' };
    }

    const resumeRepoPath = await resolveRepoPath(strapi, projectSlug, device, repoPath, project?.repoPath);

    // Append user message
    const messages = [...(existing.messages || []), { role: 'user', content: prompt, timestamp: Date.now() }];
    await strapi.documents(UID).update({
      documentId: resumeSessionId,
      data: { messages, status: 'running' } as any,
    });

    // Send to desktop
    setTimeout(() => {
      sendToDevice(device, 'agent:send', {
        sessionId: resumeSessionId,
        message: prompt,
        claudeSessionId: existing.claudeSessionId,
        repoPath: resumeRepoPath,
      });
    }, 300);

    if (stream) {
      startSSEStream(ctx, resumeSessionId);
      ctx.res.write(`event: session\ndata: ${JSON.stringify({ sessionId: resumeSessionId, claudeSessionId: existing.claudeSessionId || null })}\n\n`);
      return;
    }

    ctx.status = 200;
    return { data: { sessionId: resumeSessionId, status: 'running' } };
  }

  // New session — resolve runner
  const resolved = await resolveRunner(requestedRunner, project, deviceId);
  if (resolved.error) {
    ctx.status = resolved.status || 503;
    return { error: resolved.error };
  }

  // Antigravity path
  if (resolved.runner === 'antigravity') {
    const agRepoPath = await resolveRepoPath(strapi, projectSlug, null, repoPath, project?.repoPath);
    return runAntigravity(ctx, strapi, project, prompt, agRepoPath, stream, resolved.antigravityAllocation);
  }

  // Desktop path (existing)
  const device = resolved.device!;
  const effectiveRepoPath = await resolveRepoPath(strapi, projectSlug, device, repoPath, project?.repoPath);
  const now = Date.now();
  const cleanTitle = prompt.slice(0, 120);
  const messages = [{ role: 'user', content: prompt, timestamp: now }];

  const sessionData: any = {
    title: cleanTitle,
    status: 'running',
    messages,
    repoPath: effectiveRepoPath,
    metadata: { origin: 'claude-proxy', runner: 'desktop', deviceId: device },
  };
  if (project) sessionData.project = project.documentId;

  const session = await strapi.documents(UID).create({ data: sessionData });
  if (device !== 'default') clearDeviceAllocation(device);

  const sid = session.documentId;

  // Send agent command to desktop (defer for SSE subscription)
  setTimeout(() => {
    sendToDevice(device, 'agent:start', {
      sessionId: sid,
      repoPath: effectiveRepoPath,
      prompt,
      projectSlug,
      projectDocumentId: project?.documentId,
    });
  }, 500);

  if (stream) {
    startSSEStream(ctx, sid);
    ctx.res.write(`event: session\ndata: ${JSON.stringify({ sessionId: sid, claudeSessionId: session.claudeSessionId || null })}\n\n`);
    return;
  }

  ctx.status = 201;
  return { data: { sessionId: sid, status: 'running' } };
}
