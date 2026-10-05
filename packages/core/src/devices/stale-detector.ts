import { DEVICE_MACHINE } from '@forge/contracts/runner-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { BOX_STALE_MS } from '../lib/dispatch-liveness.js';
import { deviceRoom, roomManager } from '../lib/rooms.js';
import { transition } from '../lifecycle/index.js';

export async function runDeviceStaleSweep(): Promise<{
  markedOffline: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const { rows } = await transition(db, DEVICE_MACHINE, {
    to: 'offline',
    from: 'online',
    where: sql`(last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => ${BOX_STALE_MS / 1000}))`,
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
