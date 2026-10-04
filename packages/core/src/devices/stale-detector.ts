import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

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
