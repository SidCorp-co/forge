// Rocket.Chat as the first conversation adapter: the four ports, over the four
// functions that already did this work for the bot.
//
// Nothing new happens here. `resolveVenue` is the room shape plus the key the
// connection manager already built, `resolveSpeaker` is the assistant's own
// resolver, `deliver` is the single outbound door, and `fetchHistory` is the
// history the seed already reads.

import { and, eq } from 'drizzle-orm';
import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import {
  resolveSpeaker as resolveForgeSpeaker,
  type SpeakerResolution,
} from '../../assistant/identity/speaker-link.js';
import type {
  ConversationAdapterPorts,
  ConversationHistoryMessage,
  ConversationVenue,
  DeliveryOptions,
  DeliveryReceipt,
  RequestAck,
  ScreenedMessage,
} from '../../conversations/ports.js';
import { db } from '../../db/client.js';
import { integrationBindings, integrationConnections } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { reframed } from '../../messaging/proven.js';
import { decryptConnectionSecrets } from '../store.js';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import { type LiveConnection, liveConnectionFor } from './live-connections.js';
import { FIXED_REPLY_CONSTANT, type ReplySendProof, sendFixedReply } from './outbound.js';
import {
  fetchRoomHistory,
  fetchThreadMessages,
  type RocketChatRestAuth,
  type RocketChatRestMessage,
  reactToMessage,
} from './rest-client.js';
import { type RoomShape, resolveRoomShape } from './room-shape.js';
import type { RocketChatBindingConfig, RocketChatConfig, RocketChatSecrets } from './types.js';

/** What Rocket.Chat hands the ports: the message, the credential it arrived on, and the room's binding. */
export interface RocketChatFrame {
  m: RocketChatIncomingMessage;
  auth: RocketChatRestAuth;
  projectId: string;
  /** The room's shape where the caller already resolved it; omitted, the port resolves it itself. */
  shape?: RoomShape | undefined;
}

export function rocketChatVenueId(namespace: string, rid: string, tmid?: string | null): string {
  return tmid ? `${namespace} ${rid} ${tmid}` : `${namespace} ${rid}`;
}

export interface RocketChatVenueParts {
  namespace: string;
  rid: string;
  tmid: string | null;
}

export function parseRocketChatVenueId(externalId: string): RocketChatVenueParts | null {
  const parts = externalId.split(' ');
  if (parts.length < 2 || parts.length > 3) return null;
  const [namespace, rid, tmid] = parts as [string, string, string | undefined];
  if (!namespace || !rid) return null;
  return { namespace, rid, tmid: tmid ?? null };
}

/** The connection a room is served through, and the REST credential it holds. */
export interface VenueConnection {
  connectionId: string;
  auth: RocketChatRestAuth;
}

async function connectionForVenue(
  namespace: string,
  rid: string,
  projectId: string,
): Promise<VenueConnection | null> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.provider, 'rocketchat'),
        eq(integrationConnections.active, true),
      ),
    );

  const onServer = rows.filter((row) => {
    const config = (row.config ?? {}) as RocketChatConfig;
    return Boolean(config.serverUrl) && namespaceFromServerUrl(config.serverUrl) === namespace;
  });
  if (onServer.length === 0) return null;

  const bindings = await db
    .select({
      connectionId: integrationBindings.connectionId,
      projectId: integrationBindings.projectId,
      config: integrationBindings.config,
    })
    .from(integrationBindings)
    .where(
      and(eq(integrationBindings.provider, 'rocketchat'), eq(integrationBindings.active, true)),
    );
  const watching = new Set(
    bindings
      .filter(
        (b) =>
          b.projectId === projectId &&
          ((b.config ?? {}) as RocketChatBindingConfig).rids?.includes(rid),
      )
      .map((b) => b.connectionId),
  );

  const candidates = onServer
    .filter((r) => watching.has(r.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (candidates.length > 1) {
    logger.warn(
      { namespace, rid, projectId, connectionIds: candidates.map((c) => c.id) },
      'rocketchat: more than one active connection binds this room under this project; answering on the first by id',
    );
  }
  for (const row of candidates) {
    const config = (row.config ?? {}) as RocketChatConfig;
    const secrets = decryptConnectionSecrets<RocketChatSecrets>(row);
    if (!secrets.authToken || !secrets.userId) continue;
    return {
      connectionId: row.id,
      auth: {
        serverUrl: config.serverUrl,
        authToken: secrets.authToken,
        userId: secrets.userId,
      },
    };
  }
  return null;
}

async function authForVenue(
  namespace: string,
  rid: string,
  projectId: string,
): Promise<RocketChatRestAuth | null> {
  return (await connectionForVenue(namespace, rid, projectId))?.auth ?? null;
}

/**
 * The emoji a received request is marked with, and the one the terminal clear removes.
 */
export const RECEIVED_EMOJI = 'eyes';

/**
 * Show the room the bot is typing, under the name the server will accept.
 */
async function showActivity(
  live: LiveConnection,
  connectionId: string,
  rid: string,
  on: boolean,
): Promise<void> {
  if (live.activityRefused || !live.username) return;
  try {
    await live.client.notifyUserActivity(rid, live.username, on);
    return;
  } catch (first) {
    if (live.displayName && live.displayName !== live.username) {
      try {
        await live.client.notifyUserActivity(rid, live.displayName, on);
        return;
      } catch (second) {
        live.activityRefused = true;
        logger.warn(
          { err: second, firstErr: first, connectionId, rid },
          'rocketchat: the server refused the typing indicator under both of the bot names; no further attempts on this connection',
        );
        return;
      }
    }
    live.activityRefused = true;
    logger.warn(
      { err: first, connectionId, rid },
      'rocketchat: the server refused the typing indicator and the bot has no other name to try; no further attempts on this connection',
    );
  }
}

function toHistory(
  messages: RocketChatRestMessage[],
  botUserId: string,
): ConversationHistoryMessage[] {
  const out: ConversationHistoryMessage[] = [];
  for (const m of messages) {
    if (m.isSystem || !m.text.trim()) continue;
    out.push({
      role: m.userId === botUserId ? 'assistant' : 'user',
      authorLabel: m.username ?? null,
      content: m.text,
    });
  }
  return out;
}

export const rocketChatConversationPorts: ConversationAdapterPorts<RocketChatFrame> = {
  adapter: 'rocketchat',

  venueScope(externalId: string): string | null {
    const parts = parseRocketChatVenueId(externalId);
    return parts ? `${parts.namespace} ` : null;
  },

  async resolveVenue(frame: RocketChatFrame): Promise<ConversationVenue | null> {
    const namespace = namespaceFromServerUrl(frame.auth.serverUrl);
    if (!namespace) return null;
    const shape = frame.shape ?? (await resolveRoomShape(frame.auth, frame.m.rid));
    if (!shape) return null;
    return {
      adapter: 'rocketchat',
      externalId: rocketChatVenueId(namespace, frame.m.rid, frame.m.tmid),
      shape,
      projectId: frame.projectId,
    };
  },

  async resolveSpeaker(frame: RocketChatFrame): Promise<SpeakerResolution> {
    const namespace = namespaceFromServerUrl(frame.auth.serverUrl);
    if (!namespace) {
      return {
        linked: false,
        refusal: {
          code: 'SPEAKER_DIRECTORY_UNREACHABLE',
          message: `This Rocket.Chat server's address (${frame.auth.serverUrl}) cannot be read as a channel identity, so nothing can be answered as you here.`,
        },
      };
    }
    return resolveForgeSpeaker(
      {
        source: 'rocketchat',
        namespace,
        externalId: frame.m.userId,
        label: frame.m.username ?? null,
      },
      frame.projectId,
    );
  },

  async deliver(
    venue: ConversationVenue,
    message: ScreenedMessage,
    opts?: DeliveryOptions,
  ): Promise<DeliveryReceipt> {
    const parts = parseRocketChatVenueId(venue.externalId);
    if (!parts) {
      throw new Error(`rocketchat: "${venue.externalId}" is not a Rocket.Chat venue id`);
    }
    const auth = await authForVenue(parts.namespace, parts.rid, venue.projectId);
    if (!auth) {
      throw new Error(
        `rocketchat: no active connection on ${parts.namespace} holds a binding for room ${parts.rid} under project ${venue.projectId}, so ${venue.externalId} cannot be posted to — the room may have been rebound since this conversation was opened`,
      );
    }
    const text = opts?.addressee ? `@${opts.addressee} ${message.text}` : message.text;
    const proof: ReplySendProof | null =
      message.proof === null ? FIXED_REPLY_CONSTANT : reframed(message.proof, text);
    if (!proof) {
      throw new Error(
        `rocketchat: the addressed message no longer contains the text its screen admitted, so it cannot be posted under that proof (venue ${venue.externalId})`,
      );
    }
    const tmid = parts.tmid ?? opts?.anchor ?? undefined;
    const receipt = await sendFixedReply({ kind: 'rest', auth, rid: parts.rid, tmid }, text, proof);
    return text === message.text ? receipt : { ...receipt, deliveredText: text };
  },

  async acknowledge(venue: ConversationVenue, ack: RequestAck): Promise<void> {
    const parts = parseRocketChatVenueId(venue.externalId);
    if (!parts) return;
    const conn = await connectionForVenue(parts.namespace, parts.rid, venue.projectId);
    if (!conn) return;
    if (ack.kind === 'received') {
      const ok = await reactToMessage(conn.auth, ack.messageId, RECEIVED_EMOJI, ack.on);
      if (!ok) {
        logger.warn(
          { rid: parts.rid, messageId: ack.messageId, on: ack.on, connectionId: conn.connectionId },
          'rocketchat: the server refused the receipt reaction',
        );
      }
      return;
    }
    const live = liveConnectionFor(conn.connectionId);
    if (live?.client.getState() !== 'live') return;
    await showActivity(live, conn.connectionId, parts.rid, ack.on);
  },

  async canDeliver(venue: ConversationVenue): Promise<boolean> {
    const parts = parseRocketChatVenueId(venue.externalId);
    if (!parts) return false;
    return (await authForVenue(parts.namespace, parts.rid, venue.projectId)) !== null;
  },

  async fetchHistory(
    venue: ConversationVenue,
    limit: number,
  ): Promise<ConversationHistoryMessage[]> {
    const parts = parseRocketChatVenueId(venue.externalId);
    if (!parts) return [];
    const auth = await authForVenue(parts.namespace, parts.rid, venue.projectId);
    if (!auth) return [];
    const messages = parts.tmid
      ? ((await fetchThreadMessages(auth, parts.tmid, limit)) ?? [])
      : await fetchRoomHistory(auth, parts.rid, { count: limit });
    return toHistory(messages, auth.userId);
  },
};
