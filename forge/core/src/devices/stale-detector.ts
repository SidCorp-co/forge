import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export const DEVICE_STALE_DETECTOR_QUEUE = 'device-status-detector';
const DEVICE_STALE_THRESHOLD = "interval '90 seconds'";

type StaleDeviceRow = {
  id: string;
  owner_id: string;
};

export async function runDeviceStaleSweep(): Promise<{
  markedOffline: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const rows = await db.execute<StaleDeviceRow>(
    sql.raw(`
      UPDATE devices
      SET status = 'offline'
      WHERE status = 'online'
        AND (last_seen_at IS NULL OR last_seen_at < now() - ${DEVICE_STALE_THRESHOLD})
      RETURNING id, owner_id
    `),
  );

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
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(DEVICE_STALE_DETECTOR_QUEUE, '*/2 * * * *');
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
  registered = true;
}

export function resetDeviceStaleDetectorForTest(): void {
  registered = false;
}
