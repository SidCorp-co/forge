// What posting into a room takes: the bot's credential for a connection, and whether a room is
// still bound to the project a reply belongs to.

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings } from '../../db/schema.js';
import { logger } from '../../observability/logger.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import type { RocketChatBindingConfig, RocketChatConfig, RocketChatSecrets } from './types.js';

export interface RoomPostAuth {
  serverUrl: string;
  authToken: string;
  userId: string;
}

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

/** The room is still this project's to post into, right now. */
export async function roomStillBoundTo(args: {
  connectionId: string;
  projectId: string;
  rid: string;
}): Promise<boolean> {
  const rows = await db
    .select({ config: integrationBindings.config })
    .from(integrationBindings)
    .where(
      and(
        eq(integrationBindings.provider, 'rocketchat'),
        eq(integrationBindings.active, true),
        eq(integrationBindings.connectionId, args.connectionId),
        eq(integrationBindings.projectId, args.projectId),
      ),
    );
  return rows.some((r) => ((r.config ?? {}) as RocketChatBindingConfig).rids?.includes(args.rid));
}
