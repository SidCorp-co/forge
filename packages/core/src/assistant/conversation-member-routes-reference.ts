import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { conversationShapes } from '../db/schema-conversations.js';
import {
  HANDLE_FORBIDDEN,
  MEMBER_REFUSED,
  namedProjectSchema,
  participantSchema,
  ROOM_FORBIDDEN,
} from './conversation-routes-reference.js';

/** A room's whole membership as it stands, which every write answers with. */
export const membershipSchema = z.object({
  shape: z.enum(conversationShapes),
  canChangeMembership: z.boolean(),
  participants: z.array(participantSchema),
  scope: z.array(z.string()),
  scopeProjects: z.array(namedProjectSchema),
});

const personCandidateSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  addedAt: z
    .date()
    .describe('When the person joined an organization the room is in, ordering the unnamed'),
});

const handleCandidateSchema = z.object({
  userId: z.string().nullable(),
  handle: z.string(),
  project: namedProjectSchema,
  losesReaders: z.array(z.string()),
});

export const candidatesSchema = z.object({
  people: z.array(personCandidateSchema),
  handles: z.array(handleCandidateSchema),
  beyondReach: z
    .object({ named: z.array(namedProjectSchema), unnamed: z.number() })
    .describe(
      "The organization's other projects whose agent the caller cannot add, holding less than a member role there: named where the caller holds the viewer role, counted where they hold none",
    ),
});

const noRoom = fail('CONVERSATION_GONE', 'the room no longer exists, or never did');
const roomRefused = fail(ROOM_FORBIDDEN);

export const candidatesBeforeRoom = describeOperation({
  summary: 'Who the caller could open a room with in this project, before any room exists',
  responses: {
    200: json(candidatesSchema, 'The colleagues and agents that could join'),
    403: fail(
      'FORBIDDEN',
      'the caller holds less than the member role on the project; the refusal names the role it holds',
    ),
    404: fail('NOT_FOUND', 'there is no such project'),
  },
});

export const candidatesForRoom = describeOperation({
  summary: 'Who the caller could still put in this room',
  description:
    'An agent that would make the room about a project some of its people cannot read names those people in `losesReaders`.',
  responses: {
    200: json(candidatesSchema, 'The colleagues and agents that could join'),
    403: roomRefused,
    404: noRoom,
  },
});

export const addPersonToRoom = describeOperation({
  summary: 'Add a colleague to a room',
  description:
    "Who reads the room changes and nothing about what it can see does. Answers with the room's whole membership.",
  responses: {
    201: json(membershipSchema, 'The membership after the change'),
    400: fail({
      PERSON_OUT_OF_SCOPE: MEMBER_REFUSED.PERSON_OUT_OF_SCOPE,
      PERSON_NOT_FOUND: MEMBER_REFUSED.PERSON_NOT_FOUND,
    }),
    403: roomRefused,
    404: noRoom,
  },
});

export const addHandleToRoom = describeOperation({
  summary: 'Add an agent to a room',
  description:
    "What the room can see changes, so this can move its shape. Answers with the room's whole membership.",
  responses: {
    201: json(membershipSchema, 'The membership after the change'),
    400: fail({
      HANDLE_NOT_FOUND: MEMBER_REFUSED.HANDLE_NOT_FOUND,
      HANDLE_NOT_AN_AGENT: MEMBER_REFUSED.HANDLE_NOT_AN_AGENT,
      HANDLE_HAS_NO_NAME: MEMBER_REFUSED.HANDLE_HAS_NO_NAME,
      HANDLE_NOT_ON_PROJECT: MEMBER_REFUSED.HANDLE_NOT_ON_PROJECT,
    }),
    403: fail({ ...ROOM_FORBIDDEN, ...HANDLE_FORBIDDEN }),
    404: fail({
      CONVERSATION_GONE: 'the room no longer exists, or never did',
      PROJECT_GONE: 'the project the agent was named for no longer exists, or never did',
    }),
    500: fail('HANDLE_HAS_NO_NAME', 'the project has an agent that carries no handle'),
  },
});

export const removeFromRoom = describeOperation({
  summary: 'Take one person or agent out of a room',
  responses: {
    200: json(membershipSchema, 'The membership after the change'),
    400: fail({
      CONVERSATION_LAST_HANDLE:
        'the agent is the last one, and a room with none is about no project',
      CONVERSATION_LAST_PERSON:
        'the person is the last in a one-to-one room, which nobody could then read',
    }),
    403: roomRefused,
    404: fail({
      CONVERSATION_GONE: 'the room no longer exists, or never did',
      NOT_FOUND: 'there is no live member by that id',
    }),
  },
});
