/**
 * The live DDP client behind each Rocket.Chat connection this core holds,
 * written by the connection manager and read by the conversation port.
 *
 * The port reaches a room through REST for everything that has a REST verb;
 * the typing indicator has none, and rides the socket the manager already
 * keeps open. This registry is how the port finds that socket without
 * importing the manager (ISS-1088).
 */

import type { RocketChatDdpClient } from './ddp-client.js';

export interface LiveConnection {
  namespace: string;
  client: Pick<RocketChatDdpClient, 'notifyUserActivity' | 'getState'>;
  /** The bot's username, which the activity stream validates first. */
  username: string | null;
  /** The name the server shows under `UI_Use_Real_Name`, tried once when the username is refused. */
  displayName: string | null;
  /**
   * Whether the activity stream has refused this connection under both names.
   */
  // cm:guard remembered PER CONNECTION and reset by a redial: a server that refuses the write refuses it every time, and a port that kept trying would log the same refusal on every renewal of every turn (ISS-1088 criterion 27).
  activityRefused: boolean;
}

// cm:guard keyed by CONNECTION ID and never by room: two connections under two bot accounts may bind one room, and the port must show activity as the same bot that reacts and answers — the one `connectionForVenue` selects — so it asks for that connection by id rather than for "the connection on this room" (ISS-1088 criterion 26; plan consult F6).
const live = new Map<string, LiveConnection>();

export function registerLiveConnection(
  connectionId: string,
  connection: Omit<LiveConnection, 'activityRefused'>,
): void {
  live.set(connectionId, { ...connection, activityRefused: false });
}

export function unregisterLiveConnection(connectionId: string): void {
  live.delete(connectionId);
}

export function liveConnectionFor(connectionId: string): LiveConnection | undefined {
  return live.get(connectionId);
}

/** Test seam — the registry is process-global by design. */
export function clearLiveConnections(): void {
  live.clear();
}
