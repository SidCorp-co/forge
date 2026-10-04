import { RUNNER_MACHINE } from '@forge/contracts/runner-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { transition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { projectRoom, runnerRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { insertRunnerEvent } from './runner-events.js';

export const RUNNER_STALE_DETECTOR_QUEUE = 'runner-status-detector';
const RUNNER_STALE_THRESHOLD = "interval '30 seconds'";

export async function runRunnerStaleSweep(): Promise<{
  markedOffline: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const { rows } = await transition(db, RUNNER_MACHINE, {
    to: 'offline',
    from: 'online',
    set: { updatedAt: new Date() },
    where: sql.raw(`(last_seen_at IS NULL OR last_seen_at < now() - ${RUNNER_STALE_THRESHOLD})`),
    reason: 'stale',
    actor: { type: 'sweeper' },
    source: 'runner-stale-detector',
    returning: ['id', 'projectId'],
  });

  for (const row of rows) {
    // every returned row left `online`, the one state the move was taken from
    await insertRunnerEvent(db, {
      runnerId: row.id,
      projectId: row.projectId,
      oldStatus: 'online',
      newStatus: 'offline',
      reason: 'stale',
    });
    roomManager.publish(runnerRoom(row.id), {
      event: 'runner.status',
      data: { runnerId: row.id, status: 'offline', reason: 'stale' },
    });
    roomManager.publish(projectRoom(row.projectId), {
      event: 'runner.status',
      data: { runnerId: row.id, status: 'offline', reason: 'stale' },
    });
  }

  return { markedOffline: rows.length, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerRunnerStaleDetector(): Promise<void> {
  if (registered) return;
  const queues = boss as unknown as {
    createQueue(name: string): Promise<void>;
    work(name: string, handler: () => Promise<void>): Promise<string>;
  };
  await queues.createQueue(RUNNER_STALE_DETECTOR_QUEUE);
  await queues.work(RUNNER_STALE_DETECTOR_QUEUE, async () => {
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
