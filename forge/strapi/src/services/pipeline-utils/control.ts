/**
 * Global pipeline control: pause/resume, dispatch queued sessions.
 */

import { SESSION_UID } from './constants';

// ─── Global Pipeline Pause (DB-persisted via core_store) ────────────────────

const PIPELINE_CONTROL_KEY = 'plugin_pipeline_control';

/** In-memory cache to avoid DB reads on every dispatch call. */
let _pausedCache: boolean | null = null;

/** Load the paused state from DB into cache. Called at bootstrap. */
export async function loadPipelineControlState(strapi: any): Promise<void> {
  try {
    const val = await strapi.store.get({ key: PIPELINE_CONTROL_KEY });
    _pausedCache = val?.paused === true;
    strapi.log.info(`[pipeline] Pipeline control state: paused=${_pausedCache}`);
  } catch (err: any) {
    _pausedCache = false;
    strapi.log.warn(`[pipeline] Failed to load pipeline control state: ${err.message}`);
  }
}

/** Check if the global pipeline is paused. Uses in-memory cache (synced on set + boot). */
export function isPipelinePaused(): boolean {
  return _pausedCache === true;
}

/** Set the global pipeline paused state. Persists to DB + updates cache. */
export async function setPipelinePaused(strapi: any, paused: boolean): Promise<void> {
  await strapi.store.set({ type: 'core', key: PIPELINE_CONTROL_KEY, value: { paused } });
  _pausedCache = paused;
}

/** Get the pipeline control state for the API. */
export function getPipelineControlState(): { paused: boolean } {
  return { paused: _pausedCache === true };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find all queued pipeline sessions and dispatch each unique project+runner pair.
 * Shared by: boot cleanup, stale watcher, and resume-from-pause.
 */
export async function dispatchAllQueued(strapi: any, tag = 'pipeline'): Promise<void> {
  const allQueued = await strapi.documents(SESSION_UID).findMany({
    filters: { status: 'queued' },
    populate: ['project'],
    limit: 100,
  });

  const pairs = new Set<string>();
  const skipped: string[] = [];
  for (const s of allQueued) {
    if (s.metadata?.type !== 'pipeline') {
      skipped.push(`${s.documentId.slice(0, 8)}(type=${s.metadata?.type})`);
      continue;
    }
    const pid = s.project?.documentId;
    const runner = s.metadata?.runner || 'desktop';
    if (pid) pairs.add(`${pid}:${runner}`);
  }
  strapi.log.info(
    `[${tag}] dispatchAllQueued: ${allQueued.length} queued, ${pairs.size} pairs [${[...pairs].map(p => p.slice(0, 12)).join(', ')}]${skipped.length ? `, ${skipped.length} non-pipeline` : ''}`,
  );

  for (const key of pairs) {
    const [pid, runner] = key.split(':');
    try {
      const { dispatchNextForProject } = await import('../pipeline-orchestrator');
      await dispatchNextForProject(strapi, pid, runner as 'desktop' | 'antigravity');
    } catch (err: any) {
      strapi.log.warn(`[${tag}] dispatch failed for ${key}: ${err.message}`);
    }
  }
}
