// A box's online/offline flip, told to the box and to every project it serves, whose screens state it (ISS-1228).

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export async function publishBoxState(
  deviceId: string,
  status: 'online' | 'offline',
  reason?: string,
): Promise<void> {
  roomManager.publish(deviceRoom(deviceId), {
    event: 'device.status',
    data: { deviceId, status, ...(reason ? { reason } : {}) },
  });
  const projects = (await db.execute(sql`
    SELECT DISTINCT project_id FROM runners WHERE device_id = ${deviceId}::uuid
  `)) as unknown as Array<{ project_id: string }>;
  for (const { project_id: projectId } of projects) {
    roomManager.publish(projectRoom(projectId), {
      event: 'device.status',
      data: { deviceId, projectId, status },
    });
  }
}
