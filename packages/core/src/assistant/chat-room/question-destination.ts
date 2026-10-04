// Where one owed round goes, answered from the question's own origin.
//
// Until ISS-1091 there was one answer — `roomForProject` — and a question
// raised while answering a conversation window was posted in a room the asker
// may never have been in, with its thread registered there, so the answer could
// only ever be typed by people who were not asked.
//
// What this module refuses is as load-bearing as what it resolves. A round
// whose destination cannot be worked out is REFUSED BY NAME and never widened
// back to the project's room: falling back there is what put the question in
// the wrong room in the first place, and for a round marked private it is a
// disclosure rather than a misdelivery.

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings, integrationConnections } from '../../db/schema.js';
import type { QuestionOrigin, QuestionStep } from '../../db/schema-questions.js';
import type {
  RocketChatBindingConfig,
  RocketChatConfig,
} from '../../integrations/rocketchat/index.js';
import {
  directRoomFor,
  namespaceFromServerUrl,
  questionThread,
  resolveRoomPostAuth,
  roomForProject,
} from '../../integrations/rocketchat/index.js';
import { parseRocketChatVenueId } from './port.js';

/**
 * Where a round goes, or why it goes nowhere.
 */
export type QuestionDestination =
  | {
      kind: 'room';
      connectionId: string;
      rid: string;
      /** The thread to post into, where one is already fixed; null opens one. */
      tmid: string | null;
      /** True where `tmid` is an anchor this round must TAKE before it posts. */
      takeAnchor: boolean;
    }
  | { kind: 'unresolvable'; reason: string };

/** The shapes `postRoomMessage` raises when the room is not one this bot can post in. */
const UNREACHABLE_ROOM_ERRORS = [
  'error-not-allowed',
  'error-room-not-found',
  'error-invalid-room',
  'error-not-member',
  'unauthorized',
  'status 401',
  'status 403',
  'status 404',
];

/**
 * Is this post failure a room this bot cannot reach, rather than one to retry?
 */
export function isUnreachableRoom(err: unknown): boolean {
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!text.includes('chat.postmessage')) return false;
  return UNREACHABLE_ROOM_ERRORS.some((needle) => text.includes(needle));
}

/** Which connection binds this room, under this project, on this server. */
async function connectionBinding(
  namespace: string,
  rid: string,
  projectId: string,
): Promise<string | null> {
  const connections = await db
    .select({ id: integrationConnections.id, config: integrationConnections.config })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.provider, 'rocketchat'),
        eq(integrationConnections.active, true),
      ),
    );
  const onServer = new Set(
    connections
      .filter((row) => {
        const config = (row.config ?? {}) as RocketChatConfig;
        return Boolean(config.serverUrl) && namespaceFromServerUrl(config.serverUrl) === namespace;
      })
      .map((row) => row.id),
  );
  if (onServer.size === 0) return null;

  const bindings = await db
    .select({ connectionId: integrationBindings.connectionId, config: integrationBindings.config })
    .from(integrationBindings)
    .where(
      and(
        eq(integrationBindings.provider, 'rocketchat'),
        eq(integrationBindings.active, true),
        eq(integrationBindings.projectId, projectId),
      ),
    );
  const candidates = bindings
    .filter(
      (b) =>
        onServer.has(b.connectionId) &&
        ((b.config ?? {}) as RocketChatBindingConfig).rids?.includes(rid),
    )
    .map((b) => b.connectionId)
    .sort((a, b) => a.localeCompare(b));
  return candidates[0] ?? null;
}

export interface DestinationInput {
  questionId: string;
  projectId: string;
  origin: QuestionOrigin | null;
  step: QuestionStep;
}

type ConversationOrigin = Extract<QuestionOrigin, { kind: 'conversation' }>;

const unresolvable = (reason: string): QuestionDestination => ({ kind: 'unresolvable', reason });
const openRoom = (connectionId: string, rid: string): QuestionDestination => ({
  kind: 'room',
  connectionId,
  rid,
  tmid: null,
  takeAnchor: false,
});

/**
 * Where this round goes.
 */
export async function resolveQuestionDestination(
  input: DestinationInput,
): Promise<QuestionDestination> {
  const existing = await questionThread(input.questionId);
  if (existing) {
    if (
      input.step.sensitive === true &&
      !(await isDirectRoomOf(input, existing.connectionId, existing.rid))
    ) {
      return unresolvable(
        `round ${input.step.round} is private to whoever asked, and this question is already threaded in room ${existing.rid}, which is not their direct room — one decision is one thread, so this round is not posted anywhere`,
      );
    }
    return {
      kind: 'room',
      connectionId: existing.connectionId,
      rid: existing.rid,
      tmid: existing.tmid,
      takeAnchor: false,
    };
  }
  if (!input.origin) {
    const room = await roomForProject(input.projectId);
    return room
      ? openRoom(room.connectionId, room.rid)
      : unresolvable('no Rocket.Chat room is bound to this project');
  }
  if (input.origin.kind === 'unresolved') return unresolvable(input.origin.reason);
  if (input.origin.kind === 'channel_gate') {
    throw new Error(
      `rocketchat.question-destination: ${input.origin.number} waits at a channel approve gate, which is decided signed in to Forge; question-ledger.ts:owedRounds never owes it to a room, so reaching here is a defect`,
    );
  }
  return conversationDestination(input, input.origin);
}

/** A round raised while answering a conversation goes back to the room that conversation is in. */
async function conversationDestination(
  input: DestinationInput,
  origin: ConversationOrigin,
): Promise<QuestionDestination> {
  if (origin.adapter !== 'rocketchat') {
    return unresolvable(
      `this question was asked in a ${origin.adapter} conversation, and this delivery lane posts to Rocket.Chat rooms only — it is answered where it was asked, on that surface`,
    );
  }
  const venue = parseRocketChatVenueId(origin.venueId);
  if (!venue) {
    return unresolvable(
      `the venue this question was asked in (${origin.venueId}) cannot be read as a Rocket.Chat room`,
    );
  }
  if (venue.tmid) {
    return unresolvable(
      `this question was asked while answering a Rocket.Chat thread (${venue.tmid}), and Rocket.Chat threads do not nest — a round posted there could not be told apart from the conversation it interrupts, so it is not posted`,
    );
  }
  const connectionId = await connectionBinding(venue.namespace, venue.rid, input.projectId);
  if (!connectionId) {
    return unresolvable(
      `no active Rocket.Chat connection binds room ${venue.rid} under this project any more, so the conversation this question was asked in has no route back`,
    );
  }
  if (input.step.sensitive === true) {
    return directDestination(input, origin, venue.namespace, connectionId);
  }
  return {
    kind: 'room',
    connectionId,
    rid: venue.rid,
    tmid: origin.anchorId,
    takeAnchor: origin.anchorId !== null,
  };
}

/** A private round goes to the asker's direct room, and only where that room is bound here. */
async function directDestination(
  input: DestinationInput,
  origin: ConversationOrigin,
  namespace: string,
  connectionId: string,
): Promise<QuestionDestination> {
  const auth = await resolveRoomPostAuth(connectionId, {
    source: 'rocketchat.question-destination',
    questionId: input.questionId,
  });
  if (!auth) {
    return unresolvable(
      'this round is private to whoever asked, and the connection carries no usable credentials to open a direct room with',
    );
  }
  const direct = await directRoomFor(auth, origin.askedByKey);
  if (!direct.ok) return unresolvable(direct.reason);
  const directBinding = await connectionBinding(namespace, direct.rid, input.projectId);
  if (!directBinding) {
    return unresolvable(
      `this round is private to whoever asked, and their direct room (${direct.rid}) is not among the rooms bound to this project — a reply typed there would reach nothing, so the round is not posted. Bind that room to this project, or ask this round in the open.`,
    );
  }
  return openRoom(directBinding, direct.rid);
}

/** Is this room the direct room of the person who asked? */
async function isDirectRoomOf(
  input: DestinationInput,
  connectionId: string,
  rid: string,
): Promise<boolean> {
  if (input.origin?.kind !== 'conversation') return false;
  const auth = await resolveRoomPostAuth(connectionId, {
    source: 'rocketchat.question-destination',
    questionId: input.questionId,
  });
  if (!auth) return false;
  const direct = await directRoomFor(auth, input.origin.askedByKey);
  return direct.ok && direct.rid === rid;
}
