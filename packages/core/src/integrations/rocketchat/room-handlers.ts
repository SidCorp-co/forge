// What the chat application does with a message the connection took in. The adapter owns the
// socket, the room routing and the dedupe; deciding what a message means is the assistant's and
// the conversations' work, handed in at boot so this directory imports neither.

import { portSlot } from '../../lib/port-slot.js';
import type { ActiveConnection } from './connection-manager.js';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import type { Route } from './room-routing.js';
import type { RoomShape } from './room-shape.js';
import type { ThreadSubject } from './thread-registry.js';

interface RoomHandlers {
  /** A reply in a thread Forge opened, for the question that owns it. Never throws. */
  threadReply(input: {
    subject: ThreadSubject;
    connectionId: string;
    ac: ActiveConnection;
    m: RocketChatIncomingMessage;
  }): void;
  /** A message in a bound room, taken into its conversation. A throw un-sees the message. */
  collect(input: {
    connectionId: string;
    ac: ActiveConnection;
    route: Route;
    m: RocketChatIncomingMessage;
    shape: RoomShape;
  }): Promise<void>;
}

const slot = portSlot<RoomHandlers>('rocketchat', 'provideRoomHandlers');
export const provideRoomHandlers = slot.provide;
export const roomHandlers = slot.get;

/**
 * What a support group's message is handed to (REQ-75): recorded and given to the group's session,
 * never to the team assistant, whose turns act as a Forge person a group member never is. Its own
 * slot, provided by the support module, so neither application imports the other. A throw un-sees
 * the message.
 */
interface SupportRoomHandler {
  handle(input: {
    connectionId: string;
    ac: ActiveConnection;
    route: Route;
    m: RocketChatIncomingMessage;
    shape: RoomShape;
  }): Promise<void>;
}

const supportSlot = portSlot<SupportRoomHandler>('rocketchat', 'provideSupportRoomHandler');
export const provideSupportRoomHandler = supportSlot.provide;
export const supportRoomHandler = supportSlot.get;
