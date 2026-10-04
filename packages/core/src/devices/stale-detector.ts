import { DEVICE_MACHINE } from '@forge/contracts/runner-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { transition } from '../lifecycle/transition.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

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
