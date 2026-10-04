import { DEVICE_MACHINE } from '@forge/contracts/runner-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { transition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export const DEVICE_STALE_DETECTOR_QUEUE = 'device-status-detector';
const DEVICE_STALE_THRESHOLD = "interval '90 seconds'";

export async function runDeviceStaleSweep(): Promise<{
  markedOffline: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const { rows } = await transition(db, DEVICE_MACHINE, {
    to: 'offline',
    from: 'online',
    where: sql.raw(`(last_seen_at IS NULL OR last_seen_at < now() - ${DEVICE_STALE_THRESHOLD})`),
    reason: 'stale',
    actor: { type: 'sweeper' },
    source: 'device-stale-detector',
    returning: ['id'],
  });

  for (const row of rows) {
    roomManager.publish(deviceRoom(row.id), {
      event: 'device.status',
      data: { deviceId: row.id, status: 'offline', reason: 'stale' },
    });
  }

  return { markedOffline: rows.length, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerDeviceStaleDetector(): Promise<void> {
  if (registered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(DEVICE_STALE_DETECTOR_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(DEVICE_STALE_DETECTOR_QUEUE, async () => {
    try {
      const result = await runDeviceStaleSweep();
      logger.info(result, 'device-status-detector: sweep complete');
    } catch (err) {
      logger.error({ err }, 'device-status-detector: sweep failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(DEVICE_STALE_DETECTOR_QUEUE, '*/2 * * * *');
  registered = true;
}
