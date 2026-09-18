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

// cm:guard the SERVER is part of the key and not decoration: a Rocket.Chat room id is unique within one installation only — the same guard `assistant_speaker_links.external_namespace` and `room-shape.ts`'s own cache carry — so a venue keyed on the rid alone puts two installations' rooms of that id into one conversation, which is a stranger reading somebody else's transcript. The separator is a space, which no Rocket.Chat id contains.
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

// cm:guard the ROOM decides the credential, not the server: one installation can be served by two Forge connections under two bot accounts, and the first-match answer posts as a bot the room may not hold and reads history under the wrong bot id — which silently relabels that bot's own messages as a person's. A connection with no binding naming this room is not this room's connection.
// cm:guard the binding must also name THIS venue's project, with no single-connection shortcut: a conversation outlives the binding that opened it, so a room rebound from project A to project B still has A's durable venue pointing at it — right credential, somebody else's content.
// cm:why having only one candidate connection on the server says nothing about which project owns the room today, which is why the old shortcut past the bindings is gone (ISS-1001 invariant 2).
// cm:guard the choice among several candidates is ORDERED by connection id and never left to the row order the database happens to return: two connections can legitimately bind one room under one project, and an unordered pick makes the bot a conversation speaks as change between two consecutive replies for no reason a reader could find (ISS-1002).
/** The connection a room is served through, and the REST credential it holds. */
export interface VenueConnection {
  connectionId: string;
  auth: RocketChatRestAuth;
}

// cm:guard ONE selection for the answer, the history, the reaction and the activity: `connectionForVenue` returns the connection id beside the credential, so the port shows activity on the SAME bot's socket that reacts and answers, rather than on whichever connection happens to hold the room (ISS-1088 criterion 26; plan consult F6).
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
// cm:guard ONE constant read by both halves: a set under one name and a clear under another leaves the first on the message for good (ISS-1088 criterion 30). `eyes` because it says "seen" and nothing about the answer.
export const RECEIVED_EMOJI = 'eyes';

/**
 * Show the room the bot is typing, under the name the server will accept.
 */
// cm:guard the USERNAME first and the DISPLAY NAME once on a refusal: `stream-notify-room` validates the name against the one the server shows for the account, which `UI_Use_Real_Name` flips, and the port cannot read that setting — so it tries the two names a server can show and remembers a refusal under both per connection, logging it once rather than on every renewal (ISS-1088 criteria 24, 26, 27).
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

  // cm:guard a room whose type cannot be read returns NULL and the caller refuses the message by name; there is no default shape, because `group` makes a direct room need a mention it never gets and `direct` answers unmentioned channel chatter under whoever spoke (ISS-987).
  async resolveVenue(frame: RocketChatFrame): Promise<ConversationVenue | null> {
    const namespace = namespaceFromServerUrl(frame.auth.serverUrl);
    if (!namespace) return null;
    // cm:guard the caller's shape is taken where it has one and NOT re-resolved: `route()` already refused the message by name when the room's type could not be read, so a second resolve here can only disagree with the decision that admitted the message.
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

  // cm:guard routes through `sendFixedReply` like every other reply path — `outbound.ts` is the ONE door to a room and `outbound.test.ts` fails CI on a second one. The screened value's own `problems` become the proof, so the verdict and the exact string that was screened travel together.
  // cm:guard the `@label` address is added HERE, after the screen and before the door, and reported back in `deliveredText`: the screen judged the answer and an address is not part of the answer, while the transcript must hold what the room saw (ISS-1088 criteria 20-22). An `anchor` threads the post under that message where the venue is not already a thread — the status a request is owed goes to the asker, not to the room.
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
    const proof: ReplySendProof =
      message.problems.length === 0
        ? FIXED_REPLY_CONSTANT
        : { ok: true, problems: [...message.problems] };
    const text = opts?.addressee ? `@${opts.addressee} ${message.text}` : message.text;
    const tmid = parts.tmid ?? opts?.anchor ?? undefined;
    const receipt = await sendFixedReply({ kind: 'rest', auth, rid: parts.rid, tmid }, text, proof);
    return text === message.text ? receipt : { ...receipt, deliveredText: text };
  },

  // cm:guard the reaction and the activity are DECORATION and never a message: Rocket.Chat notifies nobody of either, which is the one property an acknowledgement must have, and a port that fell back to posting when they failed would notify everybody about an answer not yet given (ISS-1088 criteria 25, 30). No live connection held by this core for the room's connection means no activity — the reaction still goes, it is REST.
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
    // cm:guard registered is not LIVE: between a socket's close and the redial that replaces it the registry still names the old client, and a write on it would wait out the DDP timeout under both names and be remembered as a server refusal (whole-set review, pass B F1).
    if (live?.client.getState() !== 'live') return;
    await showActivity(live, conn.connectionId, parts.rid, ack.on);
  },

  // cm:guard the SAME `authForVenue` the delivery makes, asked early: a session runs long, and a room rebound while it ran is not this project's to answer into. It is not a substitute for the read `deliver` makes — that one is what stops the answer being posted — it is what stops a rebound room costing a failover redispatch and a screening turn first (ISS-1039).
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
