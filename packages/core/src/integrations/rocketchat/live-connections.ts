import type { RocketChatDdpClient } from './ddp-client.js';

export interface LiveConnection {
  namespace: string;
  client: Pick<RocketChatDdpClient, 'notifyUserActivity' | 'getState'>;
  username: string | null;
  /** The name the server shows under `UI_Use_Real_Name`, tried once when the username is refused. */
  displayName: string | null;
  /**
   * Whether the activity stream has refused this connection under both names.
   */
  activityRefused: boolean;
}

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
