/**
 * Antigravity Quota Cache
 *
 * Polls all registered Antigravity runner instances and caches per-model
 * quota data per runner. Used by the pipeline to gate agent dispatch.
 *
 * Legacy mode: if no runners registered, uses the global ANTIGRAVITY_URL.
 */

import { getUsage } from './antigravity';

export interface ModelQuota {
  model: string;
  refreshLabel: string;
  segments: number[];
  /** Average of segments — 100 = all remaining, 0 = depleted */
  remaining: number;
  /** 'full' | 'warning' | 'empty' */
  status: 'full' | 'warning' | 'empty';
}

interface QuotaCache {
  models: ModelQuota[];
  fetchedAt: string;
  error: string | null;
}

const RUNNER_UID = 'api::antigravity-runner.antigravity-runner' as any;
const POLL_INTERVAL = 15 * 60 * 1000; // 15 minutes

/** Per-runner quota caches. Key = runner documentId or '__legacy__' for single-instance. */
const caches = new Map<string, QuotaCache>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Get the cached quota data for a specific runner (or legacy). */
export function getQuotaCacheForRunner(runnerId: string): QuotaCache {
  return caches.get(runnerId) || { models: [], fetchedAt: '', error: null };
}

/** Get aggregated quota cache (all runners merged). For backward compat / dashboard. */
export function getQuotaCache(): QuotaCache & { perRunner?: Record<string, QuotaCache> } {
  if (caches.size === 0) return { models: [], fetchedAt: '', error: null };

  // If only legacy, return it directly
  if (caches.size === 1 && caches.has('__legacy__')) {
    return caches.get('__legacy__')!;
  }

  // Merge: return per-runner data + aggregate
  const perRunner: Record<string, QuotaCache> = {};
  let latestFetchedAt = '';
  const modelMap = new Map<string, ModelQuota>();

  for (const [id, cache] of caches) {
    perRunner[id] = cache;
    if (cache.fetchedAt > latestFetchedAt) latestFetchedAt = cache.fetchedAt;
    for (const m of cache.models) {
      const existing = modelMap.get(m.model);
      if (!existing || m.remaining > existing.remaining) {
        modelMap.set(m.model, m);
      }
    }
  }

  return {
    models: [...modelMap.values()],
    fetchedAt: latestFetchedAt,
    error: null,
    perRunner,
  };
}

/** Check if a specific model has quota remaining on a specific runner. */
export function hasQuotaForRunner(runnerId: string, model: string): boolean {
  const cache = caches.get(runnerId);
  if (!cache || cache.models.length === 0) return true; // no data yet — allow
  const entry = cache.models.find((m) => m.model === model);
  if (!entry) return true;
  return entry.status !== 'empty';
}

/** Check if a specific model has quota remaining (any runner or legacy). */
export function hasQuota(model: string): boolean {
  if (caches.size === 0) return true;
  for (const cache of caches.values()) {
    if (cache.models.length === 0) return true;
    const entry = cache.models.find((m) => m.model === model);
    if (entry && entry.status !== 'empty') return true;
  }
  // No runner has quota for this model
  const allEmpty = [...caches.values()].every((c) => c.models.length > 0);
  return !allEmpty; // if some caches empty (no data), allow
}

/**
 * Check if ANY model has quota. Checks preferred model first, then any.
 * For runner pool: checks across all runners.
 */
export function hasAnyQuota(preferredModel?: string): boolean {
  if (caches.size === 0) return true;

  for (const cache of caches.values()) {
    if (cache.models.length === 0) return true;

    if (preferredModel) {
      const entry = cache.models.find((m) => m.model === preferredModel);
      if (entry && entry.status !== 'empty') return true;
    }

    if (cache.models.some((m) => m.status !== 'empty')) return true;
  }

  return false;
}

/** Check if a specific runner has any quota. */
export function hasAnyQuotaForRunner(runnerId: string, preferredModel?: string): boolean {
  const cache = caches.get(runnerId);
  if (!cache || cache.models.length === 0) return true;

  if (preferredModel) {
    const entry = cache.models.find((m) => m.model === preferredModel);
    if (entry) return entry.status !== 'empty';
  }

  return cache.models.some((m) => m.status !== 'empty');
}

const PROJECT_UID = 'api::project.project' as any;
const SESSION_UID = 'api::agent-session.agent-session' as any;

/**
 * Find all antigravity projectIds mapped to a runner (for quota polling).
 * Returns idle projects first, busy projects last. Caller tries each until one works.
 */
async function findAllProjectIdsForRunner(runnerId: string): Promise<string[]> {
  const projects: any[] = await strapi.documents(PROJECT_UID).findMany({
    fields: ['antigravityProjectMap'],
    limit: 200,
  });

  // Collect all antigravity projectIds mapped to this runner
  const candidates: Array<{ projectDocId: string; agProjectId: string }> = [];
  for (const p of projects) {
    const map: Record<string, string> = p.antigravityProjectMap || {};
    if (map[runnerId]) candidates.push({ projectDocId: p.documentId, agProjectId: map[runnerId] });
  }
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return [candidates[0].agProjectId];

  // Find which projects have active sessions
  const busyProjects = new Set<string>();
  const activeSessions = await strapi.documents(SESSION_UID).findMany({
    filters: { status: { $in: ['running', 'queued'] } },
    populate: ['project'],
    limit: 50,
  });
  for (const s of activeSessions) {
    if (s.project?.documentId) busyProjects.add(s.project.documentId);
  }

  // Sort: idle projects first, busy projects last
  const sorted = [...candidates].sort((a, b) => {
    const aIdle = !busyProjects.has(a.projectDocId) ? 0 : 1;
    const bIdle = !busyProjects.has(b.projectDocId) ? 0 : 1;
    return aIdle - bIdle;
  });
  return sorted.map((c) => c.agProjectId);
}

/** Fetch quota for a specific runner and update its cache. */
export async function refreshRunnerQuota(runnerId: string, endpoint?: string): Promise<QuotaCache> {
  try {
    // Find all candidate projectIds for this runner, try each until one works.
    // Project IDs can become stale (deleted/replaced on Antigravity side),
    // so we need to fall through on 404 errors.
    const projectIds = await findAllProjectIdsForRunner(runnerId);
    if (projectIds.length === 0) {
      const cache: QuotaCache = { models: [], fetchedAt: new Date().toISOString(), error: 'No project mapped to this runner' };
      caches.set(runnerId, cache);
      return cache;
    }

    let lastError: string | null = null;
    for (const projectId of projectIds) {
      try {
        const models = await getUsage(projectId, endpoint);
        const cache: QuotaCache = { models, fetchedAt: new Date().toISOString(), error: null };
        caches.set(runnerId, cache);
        strapi.log.debug(`[antigravity-quota] Refreshed ${runnerId}: ${models.length} models, ${models.filter((m) => m.status === 'empty').length} depleted`);
        return cache;
      } catch (err: any) {
        lastError = err.message;
        if (/404|500/.test(err.message)) continue; // stale project ID or runner error, try next
        throw err; // other error, bubble up
      }
    }

    // All candidates returned 404
    const cache: QuotaCache = { models: caches.get(runnerId)?.models || [], fetchedAt: new Date().toISOString(), error: lastError };
    caches.set(runnerId, cache);
    strapi.log.warn(`[antigravity-quota] All project IDs returned 404 for runner ${runnerId}`);
    return cache;
  } catch (err: any) {
    const cache: QuotaCache = { models: caches.get(runnerId)?.models || [], fetchedAt: new Date().toISOString(), error: err.message };
    caches.set(runnerId, cache);
    strapi.log.warn(`[antigravity-quota] Refresh failed for ${runnerId}: ${err.message}`);
    return cache;
  }
}

/** Fetch quota for a runner using a specific known-good projectId (bypasses findAllProjectIdsForRunner). */
export async function refreshRunnerQuotaWithProject(runnerId: string, projectId: string, endpoint?: string): Promise<QuotaCache> {
  try {
    const models = await getUsage(projectId, endpoint);
    const cache: QuotaCache = { models, fetchedAt: new Date().toISOString(), error: null };
    caches.set(runnerId, cache);
    strapi.log.debug(`[antigravity-quota] Refreshed ${runnerId} via projectId ${projectId}: ${models.length} models`);
    return cache;
  } catch (err: any) {
    const cache: QuotaCache = { models: caches.get(runnerId)?.models || [], fetchedAt: new Date().toISOString(), error: err.message };
    caches.set(runnerId, cache);
    strapi.log.warn(`[antigravity-quota] refreshRunnerQuotaWithProject failed for ${runnerId}: ${err.message}`);
    return cache;
  }
}

/** Refresh quota for all registered runners. Also cleans expired depletedModels. */
export async function refreshQuota(): Promise<QuotaCache> {
  const runners = await strapi.documents(RUNNER_UID).findMany({ limit: 100 });

  if (runners.length === 0) return getQuotaCache();

  await Promise.allSettled(
    runners.map(async (r: any) => {
      await refreshRunnerQuota(r.documentId, r.endpoint || undefined);
      await cleanExpiredDepletedModels(r);
    }),
  );

  return getQuotaCache();
}

/** Remove expired entries from a runner's depletedModels. */
async function cleanExpiredDepletedModels(runner: any): Promise<void> {
  const depletedModels: Record<string, string> = runner.depletedModels || {};
  const entries = Object.entries(depletedModels);
  if (entries.length === 0) return;

  const now = Date.now();
  const active = entries.filter(([, resetAt]) => new Date(resetAt).getTime() > now);

  if (active.length === entries.length) return; // nothing expired

  const cleaned = Object.fromEntries(active);
  await strapi.documents(RUNNER_UID).update({
    documentId: runner.documentId,
    data: { depletedModels: cleaned },
  });

  const removed = entries.length - active.length;
  strapi.log.info(`[antigravity-quota] Cleaned ${removed} expired depleted model(s) from runner ${runner.name}`);
}

/** Start the 15-minute polling interval. Call once from bootstrap. */
export function startQuotaPoller(): void {
  if (pollTimer) return;

  refreshQuota().catch(() => {});

  pollTimer = setInterval(() => {
    refreshQuota().catch(() => {});
  }, POLL_INTERVAL);

  strapi.log.info(`[antigravity-quota] Poller started (${POLL_INTERVAL / 60000}m interval)`);
}

/**
 * Parse Antigravity's "Refreshes in X hours Y minutes" label into an absolute Date.
 * Returns null if the label doesn't match expected patterns.
 */
export function parseRefreshLabel(label: string): Date | null {
  const hoursMatch = label.match(/(\d+)\s*hour/i);
  const minsMatch = label.match(/(\d+)\s*min/i);
  if (!hoursMatch && !minsMatch) return null;
  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const mins = minsMatch ? parseInt(minsMatch[1], 10) : 0;
  return new Date(Date.now() + (hours * 60 + mins) * 60 * 1000);
}

/**
 * Find the refresh time for a depleted model on a specific runner.
 * Returns an absolute Date when quota is expected to reset, or null if unknown.
 */
export function getDepletedModelRefreshTime(runnerId: string, preferredModel?: string): Date | null {
  const cache = getQuotaCacheForRunner(runnerId);
  const target = preferredModel
    ? cache.models.find((m) => m.model === preferredModel && m.status === 'empty')
    : cache.models.find((m) => m.status === 'empty');
  if (!target) return null;
  return parseRefreshLabel(target.refreshLabel);
}

/** Stop polling (for graceful shutdown). */
export function stopQuotaPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
