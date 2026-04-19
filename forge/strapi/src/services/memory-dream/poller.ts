/**
 * Dream Memory Consolidation — scheduled poller
 */

import { PROJECT_UID, CHECK_INTERVAL_MS, POLL_INTERVAL_MS, lastPollTime, setLastPollTime } from './types';
import { runDreamConsolidation } from './consolidation';

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startDreamPoller(strapi: any): void {
  if (pollTimer) return;

  strapi.log.info('[dream] Starting dream consolidation poller (checks hourly, runs every 24h)');

  pollTimer = setInterval(async () => {
    const now = Date.now();
    if (now - lastPollTime < POLL_INTERVAL_MS) return;
    setLastPollTime(now);

    strapi.log.info('[dream] Running scheduled dream consolidation...');

    try {
      const projects = await strapi.documents(PROJECT_UID).findMany({
        fields: ['documentId', 'name'],
        pagination: { pageSize: 50 },
      });

      for (const project of projects ?? []) {
        try {
          await runDreamConsolidation(strapi, project.documentId);

          // Also run lifecycle pruning (previously never called)
          const { pruneStaleMemories, invalidateStaleEdges } = await import('../agent/memory-lifecycle');
          await pruneStaleMemories(strapi, project.documentId);
          await invalidateStaleEdges(strapi, project.documentId);
        } catch (err) {
          strapi.log.warn(`[dream] Failed for project ${project.name}: ${err}`);
        }
      }
    } catch (err) {
      strapi.log.warn(`[dream] Scheduled run failed: ${err}`);
    }
  }, CHECK_INTERVAL_MS);
}
