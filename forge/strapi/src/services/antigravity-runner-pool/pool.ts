/**
 * Antigravity Runner Pool — Pool Management
 *
 * Runner allocation, availability checks, and model depletion tracking.
 */

const RUNNER_UID = 'api::antigravity-runner.antigravity-runner' as any;
const PROJECT_UID = 'api::project.project' as any;
const SESSION_UID = 'api::agent-session.agent-session' as any;

const MAX_RUNNER_CONCURRENCY = 2;

// TOCTOU guard — track runners being allocated
const allocatingRunners = new Set<string>();

export interface RunnerAllocation {
  runnerId: string;
  runnerName: string;
  agentId: string;
  /** The Antigravity projectId for this runner+project pair (from antigravityProjectMap). */
  antigravityProjectId: string;
}

/**
 * Find an available Antigravity runner from a project's runner pool.
 *
 * "Available" means:
 * 1. In the project's `antigravityRunners` pool
 * 2. Status is "online"
 * 3. Has an Antigravity projectId mapped for this project (in antigravityProjectMap)
 * 4. Not running a session for this project
 * 5. Not currently being allocated
 *
 * Falls back to legacy single-instance (antigravityProjectId) if no pool configured.
 */
export async function findAvailableRunner(projectDocId: string): Promise<RunnerAllocation | null> {
  const strapi = globalThis.strapi;
  if (!strapi) return null;

  const project = await strapi.documents(PROJECT_UID).findOne({
    documentId: projectDocId,
    populate: { antigravityRunners: true, defaultAntigravityRunner: true },
  });
  if (!project) return null;

  const runners: any[] = (project as any).antigravityRunners || [];
  const projectMap: Record<string, string> = (project as any).antigravityProjectMap || {};

  // If no runner pool, fall back to legacy single-instance
  if (runners.length === 0) {
    const legacyId = (project as any).antigravityProjectId;
    if (legacyId) {
      return {
        runnerId: '__legacy__',
        runnerName: 'Legacy',
        agentId: '',
        antigravityProjectId: legacyId,
      };
    }
    return null;
  }

  // Filter to online, non-excluded, non-disabled runners that have a project mapping
  const now = Date.now();
  const candidates = runners.filter((r: any) =>
    r.status === 'online' && !r.excluded && projectMap[r.documentId] &&
    (!r.disabledUntil || new Date(r.disabledUntil).getTime() <= now),
  );

  if (candidates.length === 0) return null;

  function allocate(r: any): RunnerAllocation {
    allocatingRunners.add(r.documentId);
    setTimeout(() => allocatingRunners.delete(r.documentId), 10_000);
    return {
      runnerId: r.documentId,
      runnerName: r.name,
      agentId: r.agentId,
      antigravityProjectId: projectMap[r.documentId],
    };
  }

  // Check which runners have running sessions — per-project (original) + cross-project cap
  const runningSessions = await strapi.documents(SESSION_UID).findMany({
    filters: {
      status: { $eq: 'running' },
    },
    populate: { project: { fields: ['documentId'] } },
    limit: 100,
  });

  const busyRunnerIds = new Set<string>();
  const runnerSessionCounts = new Map<string, number>();
  for (const s of runningSessions) {
    const meta = (s as any).metadata;
    if (!meta?.antigravityRunnerId) continue;
    // Per-project: runner is busy for THIS project if it has a running session for it
    if (meta?.type === 'pipeline' && (s as any).project?.documentId === projectDocId) {
      busyRunnerIds.add(meta.antigravityRunnerId);
    }
    // Cross-project: count total sessions per runner
    if (meta?.type === 'pipeline') {
      runnerSessionCounts.set(meta.antigravityRunnerId, (runnerSessionCounts.get(meta.antigravityRunnerId) || 0) + 1);
    }
  }

  // Return first online runner that is: not busy for this project, under cross-project cap, not allocating
  for (const r of candidates) {
    if (allocatingRunners.has(r.documentId)) continue;
    if (busyRunnerIds.has(r.documentId)) continue;
    const count = runnerSessionCounts.get(r.documentId) || 0;
    if (count >= MAX_RUNNER_CONCURRENCY) continue;
    return allocate(r);
  }

  return null;
}

/**
 * Clear the allocation lock after session creation.
 */
export function clearRunnerAllocation(runnerId: string) {
  allocatingRunners.delete(runnerId);
}

/**
 * Disable an entire runner until the given time (e.g. high-traffic cooldown).
 * Only extends an existing pause — never shortens it.
 */
export async function disableRunnerUntil(runnerId: string, until: Date): Promise<void> {
  const strapi = globalThis.strapi;
  if (!strapi || runnerId === '__legacy__') return;

  const runner = await strapi.documents(RUNNER_UID).findOne({ documentId: runnerId, fields: ['disabledUntil'] });
  if (runner?.disabledUntil && new Date(runner.disabledUntil).getTime() >= until.getTime()) {
    strapi.log.debug(`[antigravity-runner-pool] Runner ${runnerId} already paused until ${runner.disabledUntil}, skipping shorter pause`);
    return;
  }

  await strapi.documents(RUNNER_UID).update({
    documentId: runnerId,
    data: { disabledUntil: until.toISOString() },
  });
  strapi.log.info(`[antigravity-runner-pool] Runner ${runnerId} disabled until ${until.toISOString()}`);
}

/**
 * Clear the pause on a runner, making it immediately available.
 */
export async function clearRunnerPause(runnerId: string): Promise<void> {
  const strapi = globalThis.strapi;
  if (!strapi) return;

  await strapi.documents(RUNNER_UID).update({
    documentId: runnerId,
    data: { disabledUntil: null },
  });
  strapi.log.info(`[antigravity-runner-pool] Runner ${runnerId} pause cleared`);
}

/**
 * Mark a specific model as depleted on a runner until the given reset time.
 * Unlike desktop's disableDeviceUntil (which blocks the whole device), this is
 * per-model so other models on the same runner can still be used.
 */
export async function markModelDepleted(runnerId: string, model: string, until: Date): Promise<void> {
  const strapi = globalThis.strapi;
  if (!strapi || runnerId === '__legacy__') return;

  const runner = await strapi.documents(RUNNER_UID).findOne({ documentId: runnerId });
  if (!runner) return;

  const depletedModels: Record<string, string> = (runner as any).depletedModels || {};
  depletedModels[model] = until.toISOString();

  await strapi.documents(RUNNER_UID).update({
    documentId: runnerId,
    data: { depletedModels },
  });
  strapi.log.info(`[antigravity-runner-pool] Runner ${runnerId}: model "${model}" depleted until ${until.toISOString()}`);
}

/**
 * Check if a model is currently depleted on a runner.
 * Looks up the runner record and checks its depletedModels map.
 * Returns the reset ISO string if depleted, or null if available.
 */
export async function checkModelDepleted(runnerId: string, model: string): Promise<string | null> {
  const strapi = globalThis.strapi;
  if (!strapi || !model || runnerId === '__legacy__') return null;

  const runner = await strapi.documents(RUNNER_UID).findOne({ documentId: runnerId });
  if (!runner) return null;

  const depletedModels: Record<string, string> = (runner as any).depletedModels || {};
  const resetAt = depletedModels[model];
  if (!resetAt) return null;

  if (new Date(resetAt).getTime() > Date.now()) return resetAt;
  return null;
}
