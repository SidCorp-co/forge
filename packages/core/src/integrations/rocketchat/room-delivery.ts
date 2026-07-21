/**
 * ISS-727 — shared connection→auth resolver for the RC completion bridges
 * (`escalation-bridge.ts`, `agent-chat-bridge.ts`). Both need the exact same
 * lookup — connection row → decrypted secrets → presence check — before
 * posting a reply back to a room; this factors out that duplicated block so
 * it stays in lockstep across bridges.
 */
import { logger } from '../../logger.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

export interface RoomPostAuth {
  serverUrl: string;
  authToken: string;
  userId: string;
}

/**
 * Resolve a connection id into REST auth for posting to a room. Returns
 * `null` (logged) when the connection is missing or has incomplete
 * credentials — callers treat that as "cannot deliver" and fall back, never
 * throw.
 */
export async function resolveRoomPostAuth(
  connectionId: string,
  logContext: Record<string, unknown>,
): Promise<RoomPostAuth | null> {
  const connection = await findConnectionById(connectionId);
  if (!connection) {
    logger.error({ ...logContext, connectionId }, 'rocketchat: connection not found');
    return null;
  }
  const secrets = decryptConnectionSecrets<RocketChatSecrets>(connection);
  const config = (connection.config ?? {}) as RocketChatConfig;
  if (!config.serverUrl || !secrets.authToken || !secrets.userId) {
    logger.error(
      { ...logContext, connectionId },
      'rocketchat: connection missing serverUrl/credentials',
    );
    return null;
  }
  return { serverUrl: config.serverUrl, authToken: secrets.authToken, userId: secrets.userId };
}
