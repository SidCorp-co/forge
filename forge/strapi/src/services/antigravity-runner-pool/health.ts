/**
 * Antigravity Runner Pool — Health & Lifecycle
 *
 * Runner health checks, project-level antigravity health gate,
 * recovery polling, and bootstrap discovery.
 */

import { listAgents } from '../antigravity';

const RUNNER_UID = 'api::antigravity-runner.antigravity-runner' as any;
const PROJECT_UID = 'api::project.project' as any;

// ── Runner Health Check ──

const HEALTH_CHECK_INTERVAL = 60 * 1000; // 60 seconds
let healthTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Check health of a single runner by matching its agentId against the proxy agent list.
 * Updates status + lastSeen in the DB.
 */
export async function checkRunnerHealth(runner: any, agentsList?: any[]): Promise<void> {
  const strapi = globalThis.strapi;
  if (!strapi) return;

  const agentId = runner.agentId;
  if (!agentId) return;

  try {
    const agents = agentsList || await listAgents();
    const agent = agents.find((a: any) => a.agentId === agentId);

    if (!agent) {
      await strapi.documents(RUNNER_UID).update({
        documentId: runner.documentId,
        data: { status: 'offline', healthError: 'Agent not found in proxy' },
      });
      return;
    }

    const agentStatus = agent.status === 'Online' ? 'online' : 'offline';
    await strapi.documents(RUNNER_UID).update({
      documentId: runner.documentId,
      data: {
        status: agentStatus,
        lastSeen: new Date().toISOString(),
        healthError: agent.status === 'Offline' ? `Agent offline since ${agent.offlineSince}` : null,
      },
    });
  } catch (err: any) {
    const msg = err.message || 'Unknown error';
    await strapi.documents(RUNNER_UID).update({
      documentId: runner.documentId,
      data: { status: 'offline', healthError: msg },
    });
  }
}

/**
 * Poll all registered runners for health status.
 * Single listAgents() call, then match each agent to a runner by agentId.
 */
async function pollAllRunners(): Promise<void> {
  const strapi = globalThis.strapi;
  if (!strapi) return;

  const runners = await strapi.documents(RUNNER_UID).findMany({ limit: 100 });
  if (runners.length === 0) return;

  try {
    const agents = await listAgents();
    await Promise.allSettled(runners.map((r: any) => checkRunnerHealth(r, agents)));
  } catch (err: any) {
    strapi.log?.warn?.(`[antigravity-runner-pool] listAgents failed during poll: ${err.message}`);
    // Mark all runners with an error
    await Promise.allSettled(runners.map((r: any) =>
      strapi.documents(RUNNER_UID).update({
        documentId: r.documentId,
        data: { status: 'offline', healthError: `Proxy unreachable: ${err.message}` },
      }),
    ));
  }
}

/**
 * Start the health check poller. Call once from bootstrap.
 */
export function startHealthPoller(): void {
  if (healthTimer) return;

  // Initial check
  pollAllRunners().catch(() => {});

  healthTimer = setInterval(() => {
    pollAllRunners().catch(() => {});
  }, HEALTH_CHECK_INTERVAL);

  globalThis.strapi?.log?.info(`[antigravity-runner-pool] Health poller started (${HEALTH_CHECK_INTERVAL / 1000}s interval)`);
}

/**
 * Stop the health check poller.
 */
export function stopHealthPoller(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

// ── Project-Level Antigravity Health Gate ────────────────────────────────────

const PROJECT_HEALTH_POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
let projectHealthTimer: ReturnType<typeof setInterval> | null = null;

export interface AntigravityReadiness {
  ready: boolean;
  error?: string;
}

/**
 * Check if antigravity is ready for a project before queuing pipeline steps.
 *
 * Validates:
 * 1. Project has antigravity runners assigned
 * 2. At least one runner is online
 * 3. Runner has a valid project mapping (antigravityProjectMap entry)
 *
 * Returns { ready: true } if ok, or { ready: false, error } with a human-readable reason.
 */
export async function checkAntigravityReady(projectDocId: string): Promise<AntigravityReadiness> {
  const strapi = globalThis.strapi;
  if (!strapi) return { ready: false, error: 'Strapi not initialized' };

  const project = await strapi.documents(PROJECT_UID).findOne({
    documentId: projectDocId,
    populate: { antigravityRunners: true },
  });
  if (!project) return { ready: false, error: 'Project not found' };

  const runners: any[] = (project as any).antigravityRunners || [];
  const projectMap: Record<string, string> = (project as any).antigravityProjectMap || {};

  // Legacy single-instance fallback
  if (runners.length === 0) {
    const legacyId = (project as any).antigravityProjectId;
    if (!legacyId) return { ready: false, error: 'No Antigravity runners configured' };
    // Legacy mode — can't check health, allow through
    return { ready: true };
  }

  // Check if any runner is online, not excluded, with a valid project mapping
  const onlineWithMapping = runners.filter((r: any) =>
    r.status === 'online' && !r.excluded && projectMap[r.documentId],
  );

  if (onlineWithMapping.length === 0) {
    const onlineCount = runners.filter((r: any) => r.status === 'online').length;
    const excludedOnlineCount = runners.filter((r: any) => r.status === 'online' && r.excluded).length;
    const mappedCount = runners.filter((r: any) => projectMap[r.documentId]).length;
    strapi.log.info(
      `[antigravity-health] ${(project as any).slug || projectDocId.slice(0, 8)}: not ready — ${runners.length} runners (online=${onlineCount}, excluded=${excludedOnlineCount}, mapped=${mappedCount}), mapKeys=[${Object.keys(projectMap).join(',')}], runnerIds=[${runners.map((r: any) => `${r.documentId?.slice(0,8)}:${r.status}`).join(',')}]`,
    );

    if (onlineCount === 0) {
      return { ready: false, error: `All ${runners.length} Antigravity runner(s) are offline` };
    }
    if (excludedOnlineCount > 0 && excludedOnlineCount === onlineCount) {
      return { ready: false, error: `All ${onlineCount} online runner(s) are excluded from the pool` };
    }
    if (mappedCount === 0) {
      return { ready: false, error: 'No runners have a project mapping configured' };
    }
    return { ready: false, error: `${onlineCount} runner(s) online but none have a valid project mapping` };
  }

  return { ready: true };
}

/**
 * Mark a project's antigravity as errored.
 * Queued sessions stay queued — the health gate in promoteQueuedSession prevents
 * them from running. The 5-min recovery poll will dispatch them once connectivity returns.
 */
export async function pauseProjectAntigravity(projectDocId: string, error: string): Promise<void> {
  const strapi = globalThis.strapi;
  if (!strapi) return;

  // Store error on project agentConfig
  const project: any = await strapi.documents(PROJECT_UID).findOne({
    documentId: projectDocId,
    fields: ['agentConfig'],
  });
  if (!project) return;

  const agentConfig = project.agentConfig || {};
  if (agentConfig.antigravityError === error) return; // already set

  await strapi.documents(PROJECT_UID).update({
    documentId: projectDocId,
    data: { agentConfig: { ...agentConfig, antigravityError: error, antigravityErrorAt: new Date().toISOString() } },
  });

  strapi.log.warn(`[antigravity-health] Project ${projectDocId}: marked unavailable — ${error}`);
}

/**
 * Clear a project's antigravity error when connectivity is restored.
 */
export async function clearProjectAntigravityError(projectDocId: string): Promise<void> {
  const strapi = globalThis.strapi;
  if (!strapi) return;

  const project: any = await strapi.documents(PROJECT_UID).findOne({
    documentId: projectDocId,
    fields: ['agentConfig'],
  });
  if (!project?.agentConfig?.antigravityError) return;

  const { antigravityError, antigravityErrorAt, ...cleanConfig } = project.agentConfig;
  await strapi.documents(PROJECT_UID).update({
    documentId: projectDocId,
    data: { agentConfig: cleanConfig },
  });
  strapi.log.info(`[antigravity-health] Project ${projectDocId}: antigravity error cleared, connectivity restored`);
}

/**
 * Poll projects with antigravity errors to see if connectivity is restored.
 * Called every 5 minutes. When a project recovers, dispatches its queued sessions.
 */
async function pollErroredProjects(): Promise<void> {
  const strapi = globalThis.strapi;
  if (!strapi) return;

  // Find projects with antigravityError set (stored in agentConfig JSON)
  const allProjects: any[] = await strapi.documents(PROJECT_UID).findMany({
    fields: ['agentConfig', 'antigravityProjectMap'],
    populate: { antigravityRunners: true },
    limit: 200,
  });

  const errored = allProjects.filter((p: any) => p.agentConfig?.antigravityError);
  if (errored.length === 0) return;

  for (const project of errored) {
    const readiness = await checkAntigravityReady(project.documentId);
    if (readiness.ready) {
      await clearProjectAntigravityError(project.documentId);
      // Dispatch any queued sessions that may have been waiting
      try {
        const { dispatchNextForProject } = await import('../pipeline-orchestrator');
        await dispatchNextForProject(strapi, project.documentId, 'antigravity');
      } catch (err: any) {
        strapi.log.warn(`[antigravity-health] Failed to dispatch after recovery for ${project.documentId}: ${err.message}`);
      }
    }
  }
}

/**
 * Start the project-level health poller for errored projects.
 * Checks every 5 minutes if antigravity connectivity is restored.
 */
export function startProjectHealthPoller(): void {
  if (projectHealthTimer) return;

  projectHealthTimer = setInterval(() => {
    pollErroredProjects().catch((err) => {
      globalThis.strapi?.log?.warn(`[antigravity-health] Project health poll failed: ${err.message}`);
    });
  }, PROJECT_HEALTH_POLL_INTERVAL);

  globalThis.strapi?.log?.info(`[antigravity-health] Project health poller started (${PROJECT_HEALTH_POLL_INTERVAL / 1000}s interval)`);
}

/**
 * Stop the project-level health poller.
 */
export function stopProjectHealthPoller(): void {
  if (projectHealthTimer) {
    clearInterval(projectHealthTimer);
    projectHealthTimer = null;
  }
}

// ── Bootstrap ──

/**
 * Bootstrap: discover agents from the proxy and sync runner records.
 *
 * 1. Match existing runners (no agentId) to agents by checking which agent
 *    owns their mapped projects — preserves documentIds so project mappings survive.
 * 2. Create new runner records for any unmatched agents.
 */
export async function bootstrapRunners(): Promise<void> {
  const strapi = globalThis.strapi;
  if (!strapi) return;

  try {
    const [agents, proxyProjects] = await Promise.all([
      listAgents(),
      import('../antigravity').then((m) => m.listProjects()),
    ]);
    if (agents.length === 0) {
      strapi.log.info(`[antigravity-runner-pool] Bootstrap: no agents discovered from proxy`);
      return;
    }

    // Build projectId → agentId lookup from proxy
    const projectToAgent = new Map<string, string>();
    for (const p of proxyProjects.projects || []) {
      projectToAgent.set(p.projectId, p.agentId);
    }

    const existingRunners: any[] = await strapi.documents(RUNNER_UID).findMany({ limit: 100 });
    const claimedAgentIds = new Set<string>();

    // Step 1: Match existing runners without agentId to agents via their project mappings
    const allProjects: any[] = await strapi.documents(PROJECT_UID).findMany({
      fields: ['antigravityProjectMap'],
      populate: { antigravityRunners: { fields: ['documentId'] } },
      limit: 200,
    });

    for (const runner of existingRunners) {
      if (runner.agentId) {
        claimedAgentIds.add(runner.agentId);
        continue;
      }

      // Find projects mapped to this runner and check which agent owns them
      let matchedAgentId: string | null = null;
      for (const project of allProjects) {
        const map: Record<string, string> = project.antigravityProjectMap || {};
        const agProjectId = map[runner.documentId];
        if (agProjectId) {
          const agentId = projectToAgent.get(agProjectId);
          if (agentId) { matchedAgentId = agentId; break; }
        }
      }

      if (matchedAgentId && !claimedAgentIds.has(matchedAgentId)) {
        await strapi.documents(RUNNER_UID).update({
          documentId: runner.documentId,
          data: { agentId: matchedAgentId },
        });
        claimedAgentIds.add(matchedAgentId);
        strapi.log.info(`[antigravity-runner-pool] Bootstrap: matched runner "${runner.name}" → agent ${matchedAgentId}`);
      }
    }

    // Step 2: Create new runners for agents not yet claimed
    let created = 0;
    for (const agent of agents) {
      if (claimedAgentIds.has(agent.agentId)) continue;

      await strapi.documents(RUNNER_UID).create({
        data: {
          name: agent.agentId.slice(0, 8),
          agentId: agent.agentId,
          status: agent.status === 'Online' ? 'online' : 'offline',
          maxProjects: agent.maxProjects,
        },
      });
      created++;
      strapi.log.info(`[antigravity-runner-pool] Bootstrap: registered runner for agent ${agent.agentId}`);
    }

    if (created > 0) {
      strapi.log.info(`[antigravity-runner-pool] Bootstrap: registered ${created} new runner(s)`);
    } else {
      strapi.log.info(`[antigravity-runner-pool] Bootstrap: all agents matched to existing runners`);
    }
  } catch (err: any) {
    strapi.log.warn(`[antigravity-runner-pool] Bootstrap: failed to discover agents: ${err.message}`);
  }
}
