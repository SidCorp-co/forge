import { z } from 'zod';
import { describeOperation, fail, json } from '../../api-reference/describe.js';
import { tableRow } from '../../api-reference/rows.js';
import { conversationAdapters } from '../../db/schema-conversations.js';
import { assistantSpeakerLinks } from '../../db/schema-speaker-links.js';

/** Which chat account, on which channel, is being linked. */
export const speakerBodySchema = z.object({
  source: z.enum(conversationAdapters),
  externalId: z.string().min(1),
});

export const projectParamSchema = z.object({ projectId: z.uuid() });

export const unlinkParamSchema = z.object({
  source: z.enum(conversationAdapters),
  namespace: z.string(),
  externalId: z.string(),
});

const linkSchema = tableRow(assistantSpeakerLinks);

const candidateSchema = z.object({
  userId: z.string(),
  email: z.string(),
  matchedOn: z.enum(['address', 'local-part']),
  confirmable: z.boolean(),
});

export const proposalSchema = z.object({
  speaker: z.object({
    source: z.enum(conversationAdapters),
    namespace: z.string(),
    externalId: z.string(),
    username: z.string().nullable(),
    emailOnChannel: z.string().nullable(),
  }),
  candidates: z.array(candidateSchema),
  youMayConfirm: z.boolean(),
  confirm: z.object({
    method: z.string(),
    body: z.object({ source: z.enum(conversationAdapters), externalId: z.string() }),
    as: z.string(),
  }),
});

export const createdLinkSchema = z.object({ link: linkSchema });

export const unlinkedSchema = z.object({ unlinked: z.number() });

export const linkListSchema = z.object({ links: z.array(linkSchema) });

const SOURCE_UNKNOWN =
  'the body lacks `source` or `externalId`, or `source` is not a chat channel Forge knows';

const NOT_FOUND_ON_CHANNEL = {
  SPEAKER_DIRECTORY_UNSUPPORTED: 'the channel has no directory to look the speaker up in',
  SPEAKER_DIRECTORY_UNREACHABLE: "the project's chat credential could not reach the channel",
  SPEAKER_NOT_ON_CHANNEL: 'the channel knows no speaker by that id',
  SPEAKER_EMAIL_ABSENT:
    'the channel reports no email for the speaker, which a candidate is matched on',
} as const;

const notMember = fail('FORBIDDEN', 'the caller is not a member of the project');

export const proposeSpeakerLink = describeOperation({
  summary: 'Look a chat speaker up and name the Forge users their address could belong to',
  description:
    'Writes nothing. `youMayConfirm` says whether the caller is a candidate whose confirmation would be accepted.',
  responses: {
    200: json(proposalSchema, 'The speaker and who they could be'),
    400: fail('SPEAKER_SOURCE_UNKNOWN', SOURCE_UNKNOWN),
    403: notMember,
    404: fail(NOT_FOUND_ON_CHANNEL),
  },
});

export const confirmSpeakerLink = describeOperation({
  summary: 'Confirm that a chat speaker is the caller',
  description:
    'Only the person being mapped, signed in themselves, can confirm: the channel must report the address the caller holds in Forge.',
  responses: {
    201: json(createdLinkSchema, 'The link that now resolves the speaker to the caller'),
    400: fail('SPEAKER_SOURCE_UNKNOWN', SOURCE_UNKNOWN),
    403: fail({
      FORBIDDEN: 'the caller is not a member of the project',
      SPEAKER_ADDRESS_DIFFERS:
        'the local parts of the two addresses match but the domains do not, which proposes a link and cannot confirm one',
      SPEAKER_NOT_THE_TARGET: "the channel reports an address that is not the caller's",
    }),
    404: fail(NOT_FOUND_ON_CHANNEL),
    409: fail(
      'SPEAKER_ALREADY_LINKED',
      'the speaker is already linked, to the caller or to another user',
    ),
  },
});

export const listSpeakerLinks = describeOperation({
  summary: "List the chat accounts linked to the caller's Forge user",
  responses: { 200: json(linkListSchema, 'The links, newest confirmation first') },
});

export const unlinkSpeaker = describeOperation({
  summary: "Take one of the caller's chat-account links back",
  responses: {
    200: json(unlinkedSchema, 'How many links were removed'),
    400: fail('SPEAKER_SOURCE_UNKNOWN', 'the source is not a chat channel Forge knows'),
    404: fail('SPEAKER_UNLINKED', 'the caller holds no link for that speaker'),
  },
});
