import { RUNNER_MACHINE } from '@forge/contracts/runner-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectRoom, roomManager, runnerRoom } from '../lib/rooms.js';
import { transition } from '../lifecycle/transition.js';
import { insertRunnerEvent } from './runner-events.js';

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
