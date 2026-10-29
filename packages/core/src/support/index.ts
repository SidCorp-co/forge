// A Rocket.Chat support group answered by a session Forge manages (REQ-75). The design and its
// setup: `docs/proposals/rocketchat-support-session.md`.

import {
  provideSendRefusedListener,
  provideTerminalSessionBridge,
} from '../agent-sessions/index.js';
import { provideSupportRoomHandler } from '../integrations/rocketchat/index.js';
import { consume } from '../outbox/index.js';
import { deliverWaiting, drainSupportRooms, onSupportTurnEnded } from './dispatch.js';
import { expireSupportFixes } from './fixes.js';
import { handleSupportMessage } from './inbound.js';
import { INJECT_INTENT, onInjectRefused, settleInjects } from './inject.js';
import { registerSupportResults, tellAllResults } from './result.js';
import { SUPPORT_SESSION_MARKER } from './rooms.js';
import { warmColdRooms, warmProjectRooms, warmRoomsOfDevice } from './warm.js';

export { forgetMemberships } from './health.js';
export { supportRoutes } from './routes.js';
export { forgeSupportTool, SUPPORT_TOOL_READS } from './tool.js';
export { expireSupportFixes, tellAllResults, warmColdRooms };

/**
 * The recovery sweep (a process timer): a message written into a turn the box did not take waits
 * again and goes at once, and a room still holding a message no turn took is offered one. On the
 * live path nothing waits for it.
 */
export async function recoverSupportRooms(): Promise<void> {
  for (const roomId of await settleInjects()) await deliverWaiting(roomId);
  await drainSupportRooms();
}

/**
 * The group's messages to its handler, a turn's end to the next waiting messages, and a write the
 * box refused back to the room; once at boot.
 */
export function registerSupportRooms(): void {
  provideSupportRoomHandler({ handle: handleSupportMessage });
  provideTerminalSessionBridge(SUPPORT_SESSION_MARKER, onSupportTurnEnded);
  provideSendRefusedListener(INJECT_INTENT, onInjectRefused);
}

/**
 * A recorded item's result handed to the session once it is final, never progress (BC-15 r6); a room
 * declared and warmed the moment its binding is saved (BC-10, BC-11); and every room a box serves
 * warmed when that box comes online (BC-11).
 */
export function registerSupportConsumers(): void {
  registerSupportResults();
  consume('integration.changed', {
    name: 'support-rooms',
    handle: async (p: { projectId: string }) => {
      await warmProjectRooms(p.projectId);
    },
  });
  consume('device.pushed', {
    name: 'support-rooms',
    handle: async (p: {
      deviceId: string | null;
      event: string;
      data: Record<string, unknown>;
    }) => {
      if (p.deviceId && p.event === 'device.status' && p.data.status === 'online') {
        await warmRoomsOfDevice(p.deviceId);
      }
    },
  });
}
