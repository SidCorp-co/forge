// A Rocket.Chat support group answered by a session Forge manages (REQ-75). The design and its
// setup: `docs/proposals/rocketchat-support-session.md`.

import { provideTerminalSessionBridge } from '../agent-sessions/index.js';
import { provideSupportRoomHandler } from '../integrations/rocketchat/index.js';
import { consume } from '../outbox/index.js';
import { drainSupportRooms, onSupportTurnEnded } from './dispatch.js';
import { expireSupportFixes } from './fixes.js';
import { handleSupportMessage } from './inbound.js';
import { followAllItems, registerSupportProgress } from './progress.js';
import { declareSupportRooms, SUPPORT_SESSION_MARKER } from './rooms.js';

export { supportRoutes } from './routes.js';
export { forgeSupportTool, SUPPORT_TOOL_READS } from './tool.js';
export { drainSupportRooms, expireSupportFixes, followAllItems };

/** The group's messages to its handler, and a turn's end to the next waiting messages; once at boot. */
export function registerSupportRooms(): void {
  provideSupportRoomHandler({ handle: handleSupportMessage });
  provideTerminalSessionBridge(SUPPORT_SESSION_MARKER, onSupportTurnEnded);
}

/** Progress in the thread (BC-15), and a room declared the moment its binding is saved (BC-10). */
export function registerSupportConsumers(): void {
  registerSupportProgress();
  consume('integration.changed', {
    name: 'support-rooms',
    handle: async (p: { projectId: string }) => {
      await declareSupportRooms(p.projectId);
    },
  });
}
