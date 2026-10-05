// The two socket questions a kernel may ask the WebSocket door synchronously, handed to it through
// a port at boot: whether a box is listening, and the one frame that must reach it now.

import { deviceRoom, roomManager } from '../lib/rooms.js';

/** Whether any socket reads this box's room right now. */
export function boxIsListening(deviceId: string): boolean {
  return roomManager.roomSize(deviceRoom(deviceId)) > 0;
}

/**
 * Hand a frame to the box's open sockets now, answering how many took it. Only for a frame that
 * may not be written down (it carries a live credential) and whose sender acts on the receipt.
 */
export function sendToBoxNow(deviceId: string, envelope: { event: string; data: unknown }): number {
  return roomManager.publish(deviceRoom(deviceId), envelope);
}
