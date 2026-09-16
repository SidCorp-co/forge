// An open socket in a device's room, without a WS server.
//
// A `runners` row with `status='online'` is what the dispatcher's SQL gates
// read, but it is not what carries the job: `job.assigned` is published into
// `device:<id>` and the runner has no catch-up fetch. A test that seeds only
// the row is a device that is online in Postgres and unreachable in memory —
// which is a real production state, and since ISS-862 it is one the adapter
// refuses to call `dispatched`.

import { roomManager } from '../../src/ws/room-manager.js';
import { deviceRoom, type Subscriber } from '../../src/ws/rooms.js';

const OPEN = 1;

export interface OpenDeviceSocket {
  /** Every frame the room delivered, newest last. */
  frames: Array<{ event: string; data: unknown }>;
  close(): void;
}

/**
 * Subscribe a stand-in for a connected runner to `device:<deviceId>`.
 */
export function openDeviceSocket(deviceId: string): OpenDeviceSocket {
  const frames: Array<{ event: string; data: unknown }> = [];
  const sub: Subscriber = {
    readyState: OPEN,
    send(raw: string) {
      frames.push(JSON.parse(raw) as { event: string; data: unknown });
    },
  };
  roomManager.subscribe(sub, deviceRoom(deviceId));
  return {
    frames,
    close: () => roomManager.removeAll(sub),
  };
}
