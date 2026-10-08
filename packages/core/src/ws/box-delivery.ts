// The two socket questions a kernel may ask the WebSocket door synchronously, handed to it through
// a port at boot: whether a box is listening, and the one frame that must reach it now.

import type { EphemeralFrame, EphemeralTarget } from '../lib/ephemeral.js';
import { deviceRoom, projectRoom, roomManager, userRoom } from '../lib/rooms.js';

/** Whether any socket reads this box's room right now. */
export function boxIsListening(deviceId: string): boolean {
  return roomManager.roomSize(deviceRoom(deviceId)) > 0;
}

/**
 * Hand a frame to the box's open sockets now, answering how many took it. Only for a frame that
 * may not be written down (it carries a live credential, or a person's data for one computation)
 * and whose sender acts on the receipt, so it is never kept for a replay.
 */
export function sendToBoxNow(deviceId: string, envelope: { event: string; data: unknown }): number {
  return roomManager.publish(deviceRoom(deviceId), envelope, { keep: false });
}

/** The ephemeral-frame publisher `lib/ephemeral.ts` is given at boot: project, then box, then people. */
export function publishEphemeralFrame(target: EphemeralTarget, frame: EphemeralFrame): void {
  if (target.projectId) roomManager.publish(projectRoom(target.projectId), frame);
  if (target.deviceId) roomManager.publish(deviceRoom(target.deviceId), frame);
  for (const userId of target.userIds ?? []) roomManager.publish(userRoom(userId), frame);
}
