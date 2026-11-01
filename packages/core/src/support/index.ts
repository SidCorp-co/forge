// A Rocket.Chat support group answered by a session Forge manages (REQ-75). The design and its
// setup: `docs/proposals/rocketchat-support-session.md`.

import {
  provideSendRefusedListener,
  provideTerminalSessionBridge,
} from '../agent-sessions/index.js';
import { provideSpeakerLinkedListener } from '../assistant/index.js';
import {
  provideAgentSwitchGate,
  provideSupportRoomHandler,
} from '../integrations/rocketchat/index.js';
import { logger } from '../lib/logger.js';
import { onBoxListening } from '../lib/ws-listening.js';
import { consume } from '../outbox/index.js';
import { fireDueChecks } from './checks.js';
import { deliverWaiting, drainSupportRooms, onSupportTurnEnded } from './dispatch.js';
import { expireSupportFixes } from './fixes.js';
import { handleSupportMessage } from './inbound.js';
import { INJECT_INTENT, onInjectRefused, settleInjects } from './inject.js';
import { recoverLostTurns } from './lost-turns.js';
import {
  deliverReleaseNotes,
  noteReleaseShipped,
  registerSupportReleaseNotes,
} from './release-notes.js';
import { registerSupportResults, tellAllResults } from './result.js';
import { SUPPORT_SESSION_MARKER } from './rooms.js';
import { tellLinked } from './speaker-link.js';
import { agentSwitchGate } from './switches.js';
import { warmColdRooms, warmProjectRooms, warmRoomsOfDevice } from './warm.js';

export { forgetMemberships } from './health.js';
export { supportRoutes } from './routes.js';
export { forgeSupportTool, SUPPORT_TOOL_READS } from './tool.js';
/** What a recorded item or a release came to, handed on to the sessions owed it (a process timer). */
export async function followSupportResults(): Promise<void> {
  await tellAllResults();
  await deliverReleaseNotes();
}

export {
  deliverReleaseNotes,
  expireSupportFixes,
  fireDueChecks,
  noteReleaseShipped,
  recoverLostTurns,
  tellAllResults,
  warmColdRooms,
};

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
 * The group's messages to its handler, a turn's end to the next waiting messages, a write the box
 * refused back to the room, the binding door's switch question, and a box coming back to the turns
 * core lost while it was away (ISS-850); once at boot.
 */
export function registerSupportRooms(): void {
  provideSupportRoomHandler({ handle: handleSupportMessage });
  // a group an outside bot answers joins the channel agent only through its switch (REQ-77 BC-16)
  provideAgentSwitchGate(agentSwitchGate);
  provideTerminalSessionBridge(SUPPORT_SESSION_MARKER, onSupportTurnEnded);
  provideSendRefusedListener(INJECT_INTENT, onInjectRefused);
  // a link confirmed on the link page is told to the sessions of the rooms its account wrote in
  provideSpeakerLinkedListener(tellLinked);
  onBoxListening(() => {
    void recoverLostTurns().catch((err) =>
      logger.error({ err }, 'support: recovering lost turns on a box reconnect failed'),
    );
  });
}

/**
 * A recorded item's result handed to the session once it is final, never progress (BC-15 r6); a room
 * declared and warmed the moment its binding is saved (BC-10, BC-11); and every room a box serves
 * warmed when that box comes online (BC-11).
 */
export function registerSupportConsumers(): void {
  registerSupportResults();
  // a release reaching production, handed to each opted-in room's agent (ISS-854)
  registerSupportReleaseNotes();
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
