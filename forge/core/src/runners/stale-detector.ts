import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { roomManager } from '../ws/server.js';
import { projectRoom, runnerRoom } from '../ws/rooms.js';

export const RUNNER_STALE_DETECTOR_QUEUE = 'runner-status-detector';
const RUNNER_STALE_THRESHOLD = "interval '90 seconds'";

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
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(RUNNER_STALE_DETECTOR_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(RUNNER_STALE_DETECTOR_QUEUE, async () => {
    try {
      const result = await runRunnerStaleSweep();
      logger.info(result, 'runner-status-detector: sweep complete');
    } catch (err) {
      logger.error({ err }, 'runner-status-detector: sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(RUNNER_STALE_DETECTOR_QUEUE, '*/2 * * * *');
  registered = true;
}

export function resetRunnerStaleDetectorForTest(): void {
  registered = false;
}
