import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { projectRoom, runnerRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { insertRunnerEvent } from './runner-events.js';

export const RUNNER_STALE_DETECTOR_QUEUE = 'runner-status-detector';
const RUNNER_STALE_THRESHOLD = "interval '30 seconds'";

type StaleRunnerRow = {
  id: string;
  project_id: string;
};

export async function runRunnerStaleSweep(): Promise<{
  markedOffline: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const rows = await db.execute<StaleRunnerRow>(
    sql.raw(`
      UPDATE runners
      SET status = 'offline', updated_at = now()
      WHERE status = 'online'
        AND (last_seen_at IS NULL OR last_seen_at < now() - ${RUNNER_STALE_THRESHOLD})
      RETURNING id, project_id
    `),
  );

  for (const row of rows) {
    // ISS-381 (2.3) — audit the online→offline transition. The WHERE clause
    // gates on status='online', so every returned row is a real transition
    // (old_status is always 'online') — no extra change-check needed.
    await insertRunnerEvent(db, {
      runnerId: row.id,
      projectId: row.project_id,
      oldStatus: 'online',
      newStatus: 'offline',
      reason: 'stale',
    });
    roomManager.publish(runnerRoom(row.id), {
      event: 'runner.status',
      data: { runnerId: row.id, status: 'offline', reason: 'stale' },
    });
    roomManager.publish(projectRoom(row.project_id), {
      event: 'runner.status',
      data: { runnerId: row.id, status: 'offline', reason: 'stale' },
    });
  }

  return { markedOffline: rows.length, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerRunnerStaleDetector(): Promise<void> {
  if (registered) return;
  await (boss as any).createQueue(RUNNER_STALE_DETECTOR_QUEUE);
  await (boss as any).work(RUNNER_STALE_DETECTOR_QUEUE, async () => {
    try {
      const result = await runRunnerStaleSweep();
      logger.info(result, 'runner-status-detector: sweep complete');
    } catch (err) {
      logger.error({ err }, 'runner-status-detector: sweep failed');
      throw err;
    }
  });
  // ISS-198 — every minute (was */2). Lands the offline flip well inside
  // the 60s detection budget required by the acceptance criteria.
  await (boss as any).schedule(RUNNER_STALE_DETECTOR_QUEUE, '* * * * *');
  registered = true;
}

export function resetRunnerStaleDetectorForTest(): void {
  registered = false;
}
