/**
 * Antigravity proxy controller.
 * Proxies requests to the Antigravity service for project/session management.
 * Clone and init use async chat + polling to avoid blocking.
 */
import * as antigravity from '../../../services/antigravity';
import { parseAntigravityResponse } from '../../../services/antigravity';
import { getQuotaCache, refreshQuota } from '../../../services/antigravity-quota';
import { sendToSession } from '../../../services/websocket';

const SESSION_UID = 'api::agent-session.agent-session' as any;
const RUNNER_UID = 'api::antigravity-runner.antigravity-runner' as any;

export default {
  async listProjects(ctx: any) {
    try {
      const result = await antigravity.listProjects();
      ctx.body = { data: result };
    } catch (err: any) {
      strapi.log.error(`[antigravity] listProjects error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  async createProject(ctx: any) {
    try {
      const agentId = ctx.query?.agentId || ctx.request.body?.agentId;
      const result = await antigravity.createProject(undefined, undefined, agentId);
      strapi.log.info(`[antigravity] createProject result: ${JSON.stringify(result)}`);
      ctx.body = { data: result };
    } catch (err: any) {
      strapi.log.error(`[antigravity] createProject error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  async listAgents(ctx: any) {
    try {
      const result = await antigravity.listAgents();
      ctx.body = { data: result };
    } catch (err: any) {
      strapi.log.error(`[antigravity] listAgents error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  async deleteProject(ctx: any) {
    const { projectId } = ctx.params;
    try {
      await antigravity.deleteProject(projectId);
      ctx.body = { data: { ok: true } };
    } catch (err: any) {
      strapi.log.error(`[antigravity] deleteProject error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  async testConnection(ctx: any) {
    const { projectId } = ctx.params;
    try {
      const result = await antigravity.chat({
        projectId,
        message: 'Respond with exactly: OK',
        sync: true,
        timeoutSeconds: 15,
        newSession: true,
      });
      ctx.body = {
        data: {
          ok: !result.timedOut,
          response: result.response,
          elapsedSeconds: result.elapsedSeconds,
        },
      };
    } catch (err: any) {
      strapi.log.error(`[antigravity] testConnection error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  async getUsage(ctx: any) {
    const { projectId } = ctx.params;
    if (!projectId) {
      ctx.status = 400;
      ctx.body = { error: 'projectId required' };
      return;
    }
    try {
      const runnerId = ctx.query?.runnerId;
      let endpoint: string | undefined;
      if (runnerId) {
        const runner: any = await strapi.documents(RUNNER_UID).findOne({ documentId: runnerId });
        endpoint = runner?.endpoint || undefined;
      }
      const result = await antigravity.getUsage(projectId, endpoint);
      ctx.body = { data: result };
    } catch (err: any) {
      strapi.log.error(`[antigravity] getUsage error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  /** Return cached quota data (from 15-min poller). No external call. */
  async getQuota(ctx: any) {
    ctx.body = { data: getQuotaCache() };
  },

  /** Force-refresh quota cache and return updated data. */
  async refreshQuota(ctx: any) {
    try {
      const result = await refreshQuota();
      ctx.body = { data: result };
    } catch (err: any) {
      strapi.log.error(`[antigravity] refreshQuota error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  async syncSkills(ctx: any) {
    const { projectId } = ctx.params;
    const { projectDocumentId } = ctx.request.body || {};
    try {
      const result = await antigravity.syncSkills(
        strapi,
        projectId,
        projectDocumentId,
      );
      ctx.body = { data: result };
    } catch (err: any) {
      strapi.log.error(`[antigravity] syncSkills error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  async syncSkillsToAll(ctx: any) {
    try {
      const result = await antigravity.syncSkillsToAll(strapi);
      ctx.body = { data: result };
    } catch (err: any) {
      strapi.log.error(`[antigravity] syncSkillsToAll error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  /**
   * Initialize an Antigravity project: create → clone repo → sync skills.
   * Creates an agent session for streaming progress via WebSocket.
   * Returns projectId + sessionId immediately, runs init in background.
   */
  async initProject(ctx: any) {
    const { repoUrl, projectDocumentId, existingProjectId, runnerId, agentId: rawAgentId } = ctx.request.body || {};
    try {
      // Resolve agentId: use explicit agentId, or look up from runnerId
      let resolvedAgentId = rawAgentId;
      if (!resolvedAgentId && runnerId) {
        const runner: any = await strapi.documents(RUNNER_UID).findOne({ documentId: runnerId });
        resolvedAgentId = runner?.agentId || undefined;
        strapi.log.info(`[antigravity] initProject: resolved agentId=${resolvedAgentId} from runnerId=${runnerId}`);
      }

      // Step 1: Create project (or use existing one)
      let projectId = existingProjectId || '';
      if (!projectId) {
        strapi.log.info('[antigravity] initProject: creating new project...');
        const result = await antigravity.createProject(undefined, undefined, resolvedAgentId);
        strapi.log.info(`[antigravity] initProject: create result: ${JSON.stringify(result)}`);
        projectId = result.projectId || result.id || '';
      } else {
        strapi.log.info(`[antigravity] initProject: using existing project ${projectId}`);
      }

      if (!projectId) {
        strapi.log.error('[antigravity] initProject: no projectId after create');
        ctx.status = 500;
        ctx.body = { error: 'Project created but no ID returned' };
        return;
      }

      // Create agent session for streaming init progress
      const session = await strapi.documents(SESSION_UID).create({
        data: {
          title: `Antigravity init: ${projectId.slice(0, 8)}`,
          status: 'running',
          messages: [{ role: 'user', content: 'Initialize Antigravity project', timestamp: Date.now() }],
          ...(projectDocumentId ? { project: projectDocumentId } : {}),
          repoPath: repoUrl || '',
          metadata: { type: 'antigravity-init', antigravityProjectId: projectId },
        },
      });

      // Store init status for polling
      initStatuses.set(projectId, {
        status: 'created',
        steps: { create: 'done', clone: 'pending', skills: 'pending' },
        sessionId: session.documentId,
      });

      // Return immediately
      ctx.body = { data: { projectId, sessionId: session.documentId } };

      // Run background init with async chat + polling
      setImmediate(() => {
        runInitBackground(projectId, session.documentId, repoUrl, projectDocumentId).catch((err) => {
          strapi.log.error(`[antigravity] init background error: ${err.message}`);
        });
      });
    } catch (err: any) {
      strapi.log.error(`[antigravity] initProject error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  /** Poll init progress for a project. */
  async initStatus(ctx: any) {
    const { projectId } = ctx.params;
    const status = initStatuses.get(projectId);
    if (!status) {
      ctx.body = { data: { status: 'unknown', steps: {} } };
      return;
    }
    ctx.body = { data: status };
    if (status.status === 'done') {
      setTimeout(() => initStatuses.delete(projectId), 60_000);
    }
  },
};

// --- Init status tracking ---

type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
interface InitStatus {
  status: string;
  steps: Record<string, StepStatus>;
  errors?: Record<string, string>;
  sessionId?: string;
}
const initStatuses = new Map<string, InitStatus>();

function updateInitStatus(projectId: string, step: string, status: StepStatus, error?: string) {
  const s = initStatuses.get(projectId);
  if (!s) return;
  s.steps[step] = status;
  if (error) {
    s.errors = s.errors || {};
    s.errors[step] = error;
  }
  strapi.log.info(`[antigravity] init ${projectId}: ${step} → ${status}${error ? ` (${error})` : ''}`);
}

function emitMessage(sessionId: string, content: string, type = 'text') {
  sendToSession(sessionId, 'agent:message', {
    sessionId,
    type,
    content,
  });
}

const POLL_INTERVAL = 3000;
const POLL_TIMEOUT = 5 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}


/** Convert SSH git URLs to HTTPS (Antigravity has no SSH keys). */
function toHttpsUrl(url: string): string {
  // git@gitlab.com:user/repo.git → https://gitlab.com/user/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  // ssh://git@gitlab.com/user/repo.git → https://gitlab.com/user/repo.git
  const sshProto = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshProto) return `https://${sshProto[1]}/${sshProto[2]}`;
  return url;
}

/**
 * Run init steps in background using async chat + polling.
 * Streams progress to the agent session via WebSocket.
 */
async function runInitBackground(
  projectId: string,
  sessionId: string,
  repoUrl?: string,
  projectDocumentId?: string,
) {
  const messages: Array<{ role: string; content: string; timestamp: number }> = [
    { role: 'user', content: 'Initialize Antigravity project', timestamp: Date.now() },
  ];

  // Step 2: Clone repo via async chat + polling
  if (repoUrl) {
    try {
      updateInitStatus(projectId, 'clone', 'running');
      // Convert SSH URLs to HTTPS — Antigravity has no SSH keys
      const httpsUrl = toHttpsUrl(repoUrl);
      emitMessage(sessionId, `Cloning repository: ${httpsUrl}`);

      const asyncResp = await antigravity.chatAsync({
        projectId,
        message: `Clone this git repository: ${httpsUrl}\n\n1. Run: git clone ${httpsUrl}\n2. After cloning, run: ls to confirm the cloned directory exists\n3. Run: ls <cloned-dir> to list top-level files\n\nDo NOT use background commands. Run each command and wait for completion.`,
        newSession: true,
      });

      strapi.log.info(`[antigravity] init ${projectId}: clone started, requestId=${asyncResp.requestId}`);

      // Poll for clone completion
      const startTime = Date.now();
      let lastStatus = '';

      while (Date.now() - startTime < POLL_TIMEOUT) {
        await sleep(POLL_INTERVAL);

        const poll = await antigravity.chatStatus(asyncResp.requestId);
        const currentStatus = poll.status || 'unknown';

        if (currentStatus !== lastStatus) {
          lastStatus = currentStatus;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          emitMessage(sessionId, `[${elapsed}s] Clone: ${currentStatus}`);
        }

        if (currentStatus === 'Completed') {
          const response = parseAntigravityResponse(poll.result?.response || '');
          emitMessage(sessionId, response);
          messages.push({ role: 'assistant', content: `Clone completed:\n${response}`, timestamp: Date.now() });
          updateInitStatus(projectId, 'clone', 'done');
          break;
        }

        if (currentStatus === 'Failed' || poll.error) {
          const errMsg = poll.error || 'Clone failed';
          emitMessage(sessionId, `Clone failed: ${errMsg}`, 'error');
          updateInitStatus(projectId, 'clone', 'failed', errMsg);
          break;
        }
      }

      // Check timeout
      const s = initStatuses.get(projectId);
      if (s?.steps.clone === 'running') {
        updateInitStatus(projectId, 'clone', 'failed', 'Timed out');
        emitMessage(sessionId, 'Clone timed out', 'error');
      }
    } catch (err: any) {
      strapi.log.error(`[antigravity] init ${projectId}: clone error: ${err.message}`);
      updateInitStatus(projectId, 'clone', 'failed', err.message);
      emitMessage(sessionId, `Clone error: ${err.message}`, 'error');
    }
  } else {
    updateInitStatus(projectId, 'clone', 'skipped');
    emitMessage(sessionId, 'No repo URL — skipping clone');
  }

  // Step 3: Sync skills
  try {
    updateInitStatus(projectId, 'skills', 'running');
    emitMessage(sessionId, 'Syncing skills...');
    const result = await antigravity.syncSkills(strapi, projectId, projectDocumentId);
    updateInitStatus(projectId, 'skills', 'done');
    emitMessage(sessionId, `${result.skillCount} skill${result.skillCount !== 1 ? 's' : ''} synced`);
    messages.push({ role: 'assistant', content: `Skills synced: ${result.skillCount}`, timestamp: Date.now() });
  } catch (err: any) {
    strapi.log.error(`[antigravity] init ${projectId}: skills error: ${err.message}`);
    updateInitStatus(projectId, 'skills', 'failed', err.message);
    emitMessage(sessionId, `Skill sync failed: ${err.message}`, 'error');
  }

  // Mark done
  const s = initStatuses.get(projectId);
  if (s) s.status = 'done';

  // Send completion event
  sendToSession(sessionId, 'agent:complete', { sessionId });

  // Update session record
  const allDone = s && Object.values(s.steps).every((v) => v === 'done' || v === 'skipped');
  await strapi.documents(SESSION_UID).update({
    documentId: sessionId,
    data: {
      status: allDone ? 'completed' : 'failed',
      messages,
      metadata: {
        type: 'antigravity-init',
        antigravityProjectId: projectId,
        steps: s?.steps,
        errors: s?.errors,
      },
    } as any,
  });

  strapi.log.info(`[antigravity] init ${projectId}: complete (${allDone ? 'success' : 'with errors'})`);
}
