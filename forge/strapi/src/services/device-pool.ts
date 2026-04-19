import { isDeviceConnected } from './websocket';

const SESSION_UID = 'api::agent-session.agent-session' as any;
const PROJECT_UID = 'api::project.project' as any;

// Prevent TOCTOU: track devices currently being allocated
const allocatingDevices = new Set<string>();

export interface DeviceAllocation {
  deviceId: string;
  deviceName: string;
}

/**
 * Find an available device from a project's device pool.
 * Returns { deviceId, deviceName } if one is free, or null.
 *
 * Falls back to the project's defaultDevice if the pool is empty.
 *
 * "Available" means:
 * 1. In the project's `devices` pool (or is defaultDevice)
 * 2. Currently connected via WebSocket
 * 3. Not running any agent session
 * 4. Not currently being allocated by a concurrent call
 */
export async function findAvailableDevice(projectDocId: string): Promise<DeviceAllocation | null> {
  const strapi = globalThis.strapi;
  if (!strapi) return null;

  const project = await strapi.documents(PROJECT_UID).findOne({
    documentId: projectDocId,
    populate: { devices: true, defaultDevice: true },
  });
  if (!project) return null;

  const projectSlug = (project as any).slug;

  // Only include devices from the pool that have been initialized for this project
  // (have projectPaths[slug] set, or have projectsRoot configured)
  const poolDevices: any[] = (project as any).devices || [];

  function isInitializedForProject(d: any): boolean {
    if (!d) return false;
    if (d.projectPaths?.[projectSlug]) return true;
    if (d.projectsRoot) return true; // will auto-resolve to projectsRoot/slug
    return false;
  }

  function isDeviceDisabled(d: any): boolean {
    if (!d?.disabledUntil) return false;
    const until = new Date(d.disabledUntil);
    if (until.getTime() <= Date.now()) return false;
    strapi.log.debug(`[device-pool] Skipping device ${d.deviceId}: disabled until ${d.disabledUntil}`);
    return true;
  }

  // Collect unique devices from pool (skip disabled devices)
  const candidateMap = new Map<string, string>(); // deviceId → name
  for (const d of poolDevices) {
    if (d.deviceId && !candidateMap.has(d.deviceId) && isInitializedForProject(d) && !isDeviceDisabled(d)) {
      candidateMap.set(d.deviceId, d.name || d.deviceId);
    }
  }

  // No devices in pool — stay queued until a pool device becomes available
  if (candidateMap.size === 0) {
    const reasons = poolDevices.map((d: any) => `${d.name||d.deviceId}: init=${isInitializedForProject(d)} disabled=${isDeviceDisabled(d)}`);
    strapi.log.debug(`[device-pool] ${projectSlug}: 0 candidates from ${poolDevices.length} pool devices [${reasons.join(', ')}]`);
    return null;
  }

  // Filter to connected devices
  const connected = [...candidateMap.keys()].filter((id) => isDeviceConnected(id));
  if (connected.length === 0) {
    strapi.log.debug(`[device-pool] ${projectSlug}: ${candidateMap.size} candidates but none connected`);
    return null;
  }

  function allocate(id: string): DeviceAllocation {
    allocatingDevices.add(id);
    setTimeout(() => allocatingDevices.delete(id), 10_000);
    return { deviceId: id, deviceName: candidateMap.get(id) || id };
  }

  // Find which devices have running sessions scoped to this project
  const runningSessions = await strapi.documents(SESSION_UID).findMany({
    filters: {
      status: { $eq: 'running' },
      project: { documentId: { $eq: projectDocId } },
    },
    limit: 50,
  });

  const busyDeviceIds = new Set<string>();
  for (const s of runningSessions) {
    const meta = (s as any).metadata;
    if (meta?.deviceId) busyDeviceIds.add(meta.deviceId);
  }

  // Return first connected, non-busy, non-allocating device
  for (const id of connected) {
    if (!busyDeviceIds.has(id) && !allocatingDevices.has(id)) {
      return allocate(id);
    }
  }

  strapi.log.debug(`[device-pool] ${projectSlug}: all ${connected.length} connected devices busy or allocating (busy=${[...busyDeviceIds].join(',')}, allocating=${[...allocatingDevices].join(',')})`);
  return null;
}

/**
 * Clear the allocation lock after session creation.
 */
export function clearDeviceAllocation(deviceId: string) {
  allocatingDevices.delete(deviceId);
}

/**
 * Check if a device has any running sessions for a given project.
 */
export async function isDeviceBusy(projectDocId: string, deviceId: string): Promise<boolean> {
  const strapi = globalThis.strapi;
  if (!strapi) return false;

  const runningSessions = await strapi.documents(SESSION_UID).findMany({
    filters: {
      status: { $eq: 'running' },
      project: { documentId: { $eq: projectDocId } },
    },
    limit: 50,
  });

  return runningSessions.some((s: any) => s.metadata?.deviceId === deviceId);
}

// ── Per-project merge lock ──

const activeMerges = new Set<string>();
const mergeWaiters = new Map<string, Array<() => void>>();

/**
 * Acquire a per-project merge lock for sequential merge-to-baseBranch.
 * Returns a release function. Auto-releases after 30s.
 */
export async function acquireMergeLock(projectDocId: string): Promise<() => void> {
  while (activeMerges.has(projectDocId)) {
    await new Promise<void>((resolve) => {
      const queue = mergeWaiters.get(projectDocId) || [];
      queue.push(resolve);
      mergeWaiters.set(projectDocId, queue);
    });
  }

  activeMerges.add(projectDocId);

  const timeout = setTimeout(() => {
    globalThis.strapi?.log?.warn(`[device-pool] Merge lock auto-released for ${projectDocId} after 30s`);
    release();
  }, 30_000);

  let released = false;
  function release() {
    if (released) return;
    released = true;
    clearTimeout(timeout);
    activeMerges.delete(projectDocId);
    const queue = mergeWaiters.get(projectDocId);
    if (queue?.length) {
      const next = queue.shift()!;
      if (queue.length === 0) mergeWaiters.delete(projectDocId);
      next();
    }
  }

  return release;
}
