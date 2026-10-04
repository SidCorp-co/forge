import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../observability/logger.js';
import { runnersPorts } from './ports.js';
import { setRunnerStatus } from './runner-events.js';

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
    const { ghostRunnerOfflineDays } = await runnersPorts().readThresholds();
    const ghosts = await selectGhosts(ghostRunnerOfflineDays);

    let flagged = 0;
    for (const ghost of ghosts) {
      try {
        const result = await setRunnerStatus({
          runnerId: ghost.id,
          newStatus: 'disabled',
          reason: 'ghost',
          actor: { type: 'sweeper' },
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
