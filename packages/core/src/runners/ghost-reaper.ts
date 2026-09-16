/**
 * ISS-654 — the ghost-runner reaper, Tier 3 (the system handles it, not the
 * operator).
 *
 * A box that was paired once and then went away — a laptop offline three weeks
 * — sits in `runners` forever as an `offline` row: it inflates the fleet count,
 * it keeps a stage device pool pointing at nothing, and no sweep ever touched
 * it, because `runners/stale-detector.ts` only walks `online` → `offline` and
 * stops there. This pass is the next hop: `offline` past the configured
 * `ghostRunnerOfflineDays` → `disabled`.
 *
 * Driven by its own pg-boss schedule rather than the pipeline sweeper's tick —
 * the sibling `stale-detector.ts` sets that precedent for the runner axis, and
 * a runner-status pass inside the pipeline coordinator pushes that file past
 * its `no-coordinator-blob` fan-out limit. The threshold is read per pass from
 * `admin_thresholds`, never from a constant.
 */

import { sql } from 'drizzle-orm';
import { readThresholds } from '../admin/thresholds.js';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { setRunnerStatus } from './runner-events.js';

export const GHOST_RUNNER_REAPER_QUEUE = 'runner-ghost-reaper';

export interface GhostRunnerReapResult {
  flagged: number;
}

type GhostRow = { id: string; project_id: string; name: string };

async function selectGhosts(offlineDays: number): Promise<GhostRow[]> {
  return db.execute<GhostRow>(sql`
    SELECT r.id, r.project_id, r.name
    FROM runners r
    WHERE r.status = 'offline'
      AND COALESCE(r.last_seen_at, r.created_at) < now() - (${offlineDays}::int * interval '1 day')
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.runner_id = r.id AND j.status IN ('dispatched', 'running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s
        WHERE s.device_id = r.device_id AND s.status IN ('queued', 'running', 'idle')
      )
    ORDER BY COALESCE(r.last_seen_at, r.created_at) ASC
    LIMIT 200
  `);
}

/** Never throws — same contract as the sibling sweeper passes. */
export async function reapGhostRunners(): Promise<GhostRunnerReapResult> {
  try {
    const { ghostRunnerOfflineDays } = await readThresholds();
    const ghosts = await selectGhosts(ghostRunnerOfflineDays);

    let flagged = 0;
    for (const ghost of ghosts) {
      try {
        const result = await setRunnerStatus({
          runnerId: ghost.id,
          newStatus: 'disabled',
          reason: 'ghost',
        });
        if (result.changed) {
          flagged++;
          logger.info(
            {
              runnerId: ghost.id,
              projectId: ghost.project_id,
              name: ghost.name,
              offlineDays: ghostRunnerOfflineDays,
            },
            'ghost-reaper: runner disabled after prolonged absence',
          );
        }
      } catch (err) {
        logger.error({ err, runnerId: ghost.id }, 'ghost-reaper: flag failed (row skipped)');
      }
    }

    return { flagged };
  } catch (err) {
    logger.error({ err }, 'ghost-reaper: sweep failed');
    return { flagged: 0 };
  }
}

let registered = false;

export async function registerGhostRunnerReaper(): Promise<void> {
  if (registered) return;
  await boss.createQueue(GHOST_RUNNER_REAPER_QUEUE);
  await boss.work(GHOST_RUNNER_REAPER_QUEUE, async () => {
    const result = await reapGhostRunners();
    if (result.flagged > 0) logger.info(result, 'ghost-reaper: sweep complete');
  });
  await boss.schedule(GHOST_RUNNER_REAPER_QUEUE, '17 * * * *');
  registered = true;
}

export function resetGhostRunnerReaperForTest(): void {
  registered = false;
}
