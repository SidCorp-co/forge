import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';
import { answerInGroupModes } from '../db/schema-agent-selves.js';
import {
  conversationAdapters,
  conversationMessageRoles,
  conversationModes,
  conversationParticipantKinds,
  conversationShapes,
  conversationWindowCutReasons,
  conversationWindowDecisions,
} from '../db/schema-conversations.js';

/** A room's own routing thresholds; a key it did not set is absent. */
const presenceSchema = z.object({
  dormantMs: z.number().optional(),
  backoffAfter: z.number().optional(),
  loopBounceMs: z.number().optional(),
  loopLimit: z.number().optional(),
  answerInGroup: z.enum(answerInGroupModes).optional(),
});

/** A room as the conversations table holds it. */
export const conversationSchema = z.object({
  id: z.string(),
  adapter: z.enum(conversationAdapters),
  externalId: z.string(),
  shape: z.enum(conversationShapes),
  mode: z.enum(conversationModes).nullable(),
  title: z.string().nullable(),
  archivedAt: z.date().nullable(),
  presence: presenceSchema.nullable(),
});

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  isError: z.boolean().optional(),
  durationMs: z.number().optional(),
});

const contentBlockSchema = z.object({
  type: z.enum(['text', 'tool', 'todos', 'thinking']),
  text: z.string().optional(),
  toolCall: toolCallSchema.optional(),
  todos: z
    .array(
      z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
        activeForm: z.string().optional(),
      }),
    )
    .optional(),
  thinking: z.string().optional(),
  durationMs: z.number().optional(),
});

/** One turn of a room, as a person reads it. */
export const messageSchema = z.object({
  id: z.string(),
  seq: z.number(),
  externalId: z.string().nullable(),
  role: z.enum(conversationMessageRoles),
  authorUserId: z.string().nullable(),
  authorLabel: z.string().nullable(),
  authorKey: z.string().nullable(),
  replyToExternalId: z.string().nullable(),
  content: z.string(),
  blocks: z.array(contentBlockSchema).nullable(),
  images: z.array(z.object({ name: z.string(), mime: z.string(), ref: z.string() })),
  deliveryProof: z.unknown(),
  silenceReason: z.string().nullable(),
  createdAt: z.date(),
});

/** The messages that arrived together and were routed as one decision. */
export const windowSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  projectId: z.string(),
  adapter: z.enum(conversationAdapters),
  openedAt: z.date(),
  extendedAt: z.date(),
  firstSeq: z.number(),
  lastSeq: z.number(),
  claimedAt: z.date().nullable(),
  claimedBy: z.string().nullable(),
  cutReason: z.enum(conversationWindowCutReasons).nullable(),
  deliveryReservedAt: z.date().nullable(),
  closedAt: z.date().nullable(),
  decision: z.enum(conversationWindowDecisions).nullable(),
  decisionDetail: z.unknown(),
});

/** A turn the room handed to a paired box. */
export const agentTurnSchema = z.object({
  windowId: z.string(),
  sessionId: z.string(),
  state: z.enum(['dispatched', 'running', 'delivered', 'failed']),
  reason: z.string().nullable(),
});

/** One person or agent in a room, with the name a reader sees. */
export const participantSchema = z.object({
  id: z.string(),
  kind: z.enum(conversationParticipantKinds),
  userId: z.string().nullable(),
  projectId: z.string().nullable(),
  externalKey: z.string().nullable(),
  label: z.string().nullable(),
  reachable: z.boolean().nullable(),
  displayName: z.string().nullable(),
});

export const namedProjectSchema = z.object({ id: z.string(), name: z.string(), slug: z.string() });

export const agentModeOfferSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
});

export const conversationListSchema = z.object({
  items: z.array(conversationSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export const conversationDetailSchema = conversationSchema.extend({
  scope: z.array(z.string()),
  scopeProjects: z.array(namedProjectSchema),
  canChangeMembership: z.boolean(),
  agentMode: agentModeOfferSchema,
  agentTurns: z.array(agentTurnSchema),
  participants: z.array(participantSchema),
  messages: z.array(messageSchema),
  windows: z.array(windowSchema),
});

export const sentSchema = z.object({
  conversationId: z.string(),
  windowId: z.string(),
  seq: z.number(),
  decision: z.string().nullable(),
  mode: z.enum(conversationModes),
  messages: z.array(messageSchema),
  windows: z.array(windowSchema),
  agentTurns: z.array(agentTurnSchema),
});

/** What a room refuses a caller who may not look at it or change it (403). */
export const ROOM_FORBIDDEN = {
  CONVERSATION_NO_SCOPE: 'the room has no agent in it, so it is about no project',
  CONVERSATION_OUT_OF_SCOPE:
    'the caller holds too little of a role on a project the room is about; a room needs one on every project in it',
  NOT_IN_THE_ROOM:
    'the room is one-to-one, or changes who is in it, and the caller is not one of its people',
} as const;

/** The codes a handle or a person refused at the door of a room can carry (400). */
export const MEMBER_REFUSED = {
  HANDLE_NOT_FOUND: 'the named handle is not a user',
  HANDLE_NOT_AN_AGENT: 'the named handle is a person, not an agent',
  HANDLE_HAS_NO_NAME: 'the agent carries no handle on its org membership',
  HANDLE_NOT_ON_PROJECT: 'the agent is not a member of the project it was named for',
  PERSON_OUT_OF_SCOPE:
    'the person holds no role on a project the room is about, and could not read it',
} as const;

export const HANDLE_FORBIDDEN = {
  HANDLE_PROJECT_FORBIDDEN:
    'adding the agent would make the room about a project the caller holds less than member on',
} as const;

const noRoom = fail('NOT_FOUND', 'there is no such room');
const roomRefused = fail(ROOM_FORBIDDEN);
const notMember = fail({
  FORBIDDEN: 'the caller holds too little of a role on the project',
});

export const roomNotFound = noRoom;
export const roomForbidden = roomRefused;

export const listRooms = describeOperation({
  summary: "List the rooms a project's agents speak in that the caller can reach",
  description:
    'Archived rooms are listed alone when `archived` is `1` or `true`. A one-to-one room is listed only to the people in it.',
  responses: {
    200: json(conversationListSchema, 'One page of rooms'),
    403: notMember,
    404: fail('NOT_FOUND', 'there is no such project'),
  },
});

export const readAgentModeOffer = describeOperation({
  summary: 'Whether a new room in this project could be opened in Agent mode',
  responses: {
    200: json(agentModeOfferSchema, 'Available, or the reason it is not'),
    403: notMember,
    404: fail('NOT_FOUND', 'there is no such project'),
  },
});

export const openRoom = describeOperation({
  summary: 'Open a room in a project, with the colleagues and agents named',
  responses: {
    201: json(conversationSchema, 'The new room, as its membership settled it'),
    400: fail({ ...MEMBER_REFUSED }),
    403: fail({ FORBIDDEN: 'the caller is not a member of the project', ...HANDLE_FORBIDDEN }),
    404: fail('NOT_FOUND', 'there is no such project'),
    500: fail('HANDLE_HAS_NO_NAME', 'the project has an agent that carries no handle'),
  },
});

export const readRoom = describeOperation({
  summary: 'Read a room: its messages, windows, members and the turns handed to a box',
  responses: {
    200: json(conversationDetailSchema, 'The room as it stands'),
    403: roomRefused,
    404: noRoom,
  },
});

export const changeRoom = describeOperation({
  summary: 'Rename, archive or restore a room, or set its routing thresholds',
  responses: {
    200: json(conversationSchema, 'The room after the change'),
    400: fail('PRESENCE_INVALID', 'the presence names a key or a value the room cannot take'),
    403: roomRefused,
    404: noRoom,
  },
});

export const deleteRoom = describeOperation({
  summary: 'Delete a room and everything said in it',
  responses: { 204: empty('The room is gone'), 403: roomRefused, 404: noRoom },
});

export const sendToRoom = describeOperation({
  summary: 'Say something in a room and get back what the room now holds',
  description:
    "Answers 201 for an Assistant turn, which is routed before the call returns, and 202 for an Agent turn, which a paired box takes. A room's mode is written by its first message and never changes.",
  responses: {
    201: json(sentSchema, 'The message was taken in and routed'),
    202: json(sentSchema, 'The message was taken in and an Agent turn was handed to a box'),
    403: roomRefused,
    404: noRoom,
    409: fail({
      CONVERSATION_SCOPE_AMBIGUOUS:
        'the room is about more than one project, and a turn runs under one',
      CONVERSATION_NOT_WEB: 'the room was opened by another channel, which is where it is answered',
      CONVERSATION_MODE_SETTLED:
        'the message names a mode and the room already answers in one, or another message settled it first',
      CONVERSATION_AGENT_NO_DEVICE: 'no paired device is free to take an Agent turn',
      CONVERSATION_ATTACHMENT_FOREIGN: 'an attachment id is not on this room',
      CONVERSATION_SHAPE_CONFLICT: "the room's shape changed between the check and the send",
      CONVERSATION_PROJECT_CONFLICT: "the room's project changed between the check and the send",
    }),
  },
});
