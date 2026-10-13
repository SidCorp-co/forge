import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { presenceConfigSchema } from '../conversations/presence.js';
import { answerStyles, projectMemberRoles } from '../db/schema.js';

const fenceSchema = z.object({
  boundProjectId: z.string().nullable().describe('Set when the agent reaches exactly one project'),
  projectIds: z.array(z.string()).nullable().describe('Set when it reaches several'),
});

export const agentAccountSchema = z.object({
  userId: z.string(),
  handle: z.string(),
  displayName: z.string().nullable(),
  email: z.string(),
  projects: z.array(z.object({ id: z.string(), role: z.enum(projectMemberRoles) })),
  createdAt: z.date(),
  activeTokens: z.number().int(),
  canAct: z.boolean().describe('True while it holds a live token and reaches a project'),
});

export const agentListSchema = z.object({ agents: z.array(agentAccountSchema) });

export const createdAgentSchema = agentAccountSchema.extend({
  plaintext: z.string().describe('The agent token, shown this once'),
});

export const agentProjectsAnswerSchema = z.object({
  projects: z.array(z.string()),
  fence: fenceSchema,
  refenced: z.number().int().describe('How many live tokens were re-fenced to the new list'),
});

export const agentCredentialSchema = z.object({ plaintext: z.string(), fence: fenceSchema });

export const revokedTokensSchema = z.object({ revoked: z.number().int() });

export const agentNameSchema = z.object({ displayName: z.string().nullable() });

export const agentSelfSchema = z.object({
  userId: z.string(),
  soul: z.string().nullable(),
  instructions: z.string().nullable(),
  emoji: z.string().nullable(),
  greeting: z.string().nullable(),
  presence: presenceConfigSchema,
  updatedBy: z.string().nullable(),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
});

export const memberAssistantPreferencesSchema = z.object({
  userId: z.string(),
  answerStyle: z.enum(answerStyles),
  assistantInstructions: z.string().nullable(),
  updatedAt: z.date().nullable(),
});

const ADMIN_ONLY = 'the caller is not an admin of the organization';
const NO_ORG = 'the organization does not exist';
const NO_AGENT = 'the organization has no agent with this id';
const MINT_GRANT =
  'a token that holds less than the full grant tried to mint a full-grant credential';

export const listAgents = describeOperation({
  summary: 'List the agent accounts of an organization',
  responses: {
    200: json(agentListSchema),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', NO_ORG),
  },
});

export const createAgent = describeOperation({
  summary: 'Create an agent account on projects of the organization and mint its token',
  description: 'The token is in `plaintext` and is shown once.',
  responses: {
    201: json(createdAgentSchema, 'The agent, with its token'),
    400: fail(
      'INVALID_AGENT_HANDLE',
      'the handle is not 3 to 40 lowercase letters, digits or hyphens that start and end alphanumeric',
    ),
    403: fail({ FORBIDDEN: ADMIN_ONLY, PAT_MINT_NEEDS_FULL_GRANT: MINT_GRANT }),
    404: fail('NOT_FOUND', `${NO_ORG}, or a named project is not one of its projects`),
    409: fail('AGENT_HANDLE_TAKEN', 'the organization already has an agent with this handle'),
  },
});

export const setAgentProjectList = describeOperation({
  summary: 'Replace the projects an agent works on and re-fence its live tokens',
  responses: {
    200: json(agentProjectsAnswerSchema),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', `${NO_ORG}, ${NO_AGENT}, or a named project is not one of its projects`),
    409: fail(
      'AGENT_IS_A_PROJECT_HANDLE',
      'the agent holds the name a project mints its conversational handle under, so widening it would stop that project opening rooms',
    ),
  },
});

export const retireAgent = describeOperation({
  summary: 'Retire an agent: revoke its tokens and drop its memberships',
  description: 'The account row stays.',
  responses: {
    204: empty('Retired'),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', `${NO_ORG}, or ${NO_AGENT}`),
  },
});

export const mintAgentToken = describeOperation({
  summary: 'Mint another token for an existing agent',
  description: 'The token is in `plaintext` and is shown once.',
  responses: {
    201: json(agentCredentialSchema, 'The token, with the fence it carries'),
    400: fail({
      AGENT_HAS_NO_PROJECT: 'the agent is a member of no project',
      AGENT_CREDENTIAL_NAME_TAKEN:
        'every name the route would give the token is held by a live one',
    }),
    403: fail({ FORBIDDEN: ADMIN_ONLY, PAT_MINT_NEEDS_FULL_GRANT: MINT_GRANT }),
    404: fail('NOT_FOUND', `${NO_ORG}, or ${NO_AGENT}`),
  },
});

export const revokeAgentTokens = describeOperation({
  summary: 'Revoke every live token of an agent and keep the account',
  responses: {
    200: json(revokedTokensSchema, 'How many tokens were revoked'),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', `${NO_ORG}, or ${NO_AGENT}`),
  },
});

export const renameAgent = describeOperation({
  summary: 'Set or clear the label an agent is shown by',
  responses: {
    200: json(agentNameSchema, 'The label as stored'),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', `${NO_ORG}, or ${NO_AGENT}`),
  },
});

export const readAgentSelfOp = describeOperation({
  summary: 'Read who an agent is: soul, instructions, emoji, greeting and presence',
  description: 'An agent that has written nothing reads as empty fields and a blank presence.',
  responses: {
    200: json(agentSelfSchema),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', `${NO_ORG}, or ${NO_AGENT}`),
  },
});

export const patchAgentSelf = describeOperation({
  summary: 'Change who an agent is',
  description:
    'Text fields are set as sent and `null` clears one. `presence` is merged key by key onto what is stored, a key sent as `null` is removed, and the merged whole is validated.',
  responses: {
    200: json(agentSelfSchema, 'The self as stored'),
    400: fail('PRESENCE_INVALID', 'the merged presence breaks a bound; the message names each key'),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', `${NO_ORG}, or ${NO_AGENT}`),
  },
});

export const patchMemberAssistantPreferences = describeOperation({
  summary: "Set a member's assistant answer style or instructions as an org admin",
  description: 'The change is recorded in the member trail as made by an admin.',
  responses: {
    200: json(memberAssistantPreferencesSchema, 'The assistant preferences as stored'),
    403: fail('FORBIDDEN', ADMIN_ONLY),
    404: fail('NOT_FOUND', `${NO_ORG}, or the user is not a member`),
  },
});
