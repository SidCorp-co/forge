import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { BOX_SILENT_AFTER_MS } from '../jobs/box-answers.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { publishBoxState } from './box-state-publish.js';

export const DEVICE_STALE_DETECTOR_QUEUE = 'device-status-detector';
const DEVICE_STALE_THRESHOLD = `interval '${BOX_SILENT_AFTER_MS / 1000} seconds'`;

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

  for (const row of rows) await publishBoxState(row.id, 'offline', 'stale');

  return { markedOffline: rows.length, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerDeviceStaleDetector(): Promise<void> {
  if (registered) return;
  await boss.createQueue(DEVICE_STALE_DETECTOR_QUEUE);
  await boss.work(DEVICE_STALE_DETECTOR_QUEUE, async () => {
    try {
      const result = await runDeviceStaleSweep();
      logger.info(result, 'device-status-detector: sweep complete');
    } catch (err) {
      logger.error({ err }, 'device-status-detector: sweep failed');
      throw err;
    }
  });
  await boss.schedule(DEVICE_STALE_DETECTOR_QUEUE, '*/2 * * * *');
  registered = true;
}

export function resetDeviceStaleDetectorForTest(): void {
  registered = false;
}
