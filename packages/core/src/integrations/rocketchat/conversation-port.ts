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
  DeliveryReceipt,
  ScreenedMessage,
} from '../../conversations/ports.js';
import type { ConversationVenue } from '../../conversations/store.js';
import { db } from '../../db/client.js';
import { integrationBindings, integrationConnections } from '../../db/schema.js';
import { decryptConnectionSecrets } from '../store.js';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import { FIXED_REPLY_CONSTANT, type ReplySendProof, sendFixedReply } from './outbound.js';
import {
  fetchRoomHistory,
  fetchThreadMessages,
  type RocketChatRestAuth,
  type RocketChatRestMessage,
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
async function authForVenue(
  namespace: string,
  rid: string,
  projectId: string,
): Promise<RocketChatRestAuth | null> {
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

  for (const row of onServer.filter((r) => watching.has(r.id))) {
    const config = (row.config ?? {}) as RocketChatConfig;
    const secrets = decryptConnectionSecrets<RocketChatSecrets>(row);
    if (!secrets.authToken || !secrets.userId) continue;
    return {
      serverUrl: config.serverUrl,
      authToken: secrets.authToken,
      userId: secrets.userId,
    };
  }
  return null;
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
    return resolveForgeSpeaker({
      source: 'rocketchat',
      namespace,
      externalId: frame.m.userId,
      label: frame.m.username ?? null,
    });
  },

  // cm:guard routes through `sendFixedReply` like every other reply path — `outbound.ts` is the ONE door to a room and `outbound.test.ts` fails CI on a second one. The screened value's own `problems` become the proof, so the verdict and the exact string that was screened travel together.
  async deliver(venue: ConversationVenue, message: ScreenedMessage): Promise<DeliveryReceipt> {
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
    return sendFixedReply(
      { kind: 'rest', auth, rid: parts.rid, tmid: parts.tmid ?? undefined },
      message.text,
      proof,
    );
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
      ? await fetchThreadMessages(auth, parts.tmid, limit)
      : await fetchRoomHistory(auth, parts.rid, { count: limit });
    return toHistory(messages, auth.userId);
  },
};
