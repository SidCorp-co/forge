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
