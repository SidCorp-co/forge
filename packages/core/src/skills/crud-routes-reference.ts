import { z } from 'zod';
import {
  describeOperation,
  empty,
  fail,
  json,
  NO_SUCH_PROJECT,
} from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { skillScopes, skills, skillTargets } from '../db/schema.js';

/** The four JSON columns the table leaves untyped; the descriptions say what each holds. */
const jsonColumns = {
  tools: z.unknown().describe('Tool names a device pushed with the skill; empty otherwise'),
  manifest: z.unknown().describe('Free-form JSON; an empty object unless a writer set it'),
  files: z
    .unknown()
    .describe('The files shipped beside SKILL.md, each with `path`, `content` and `encoding`'),
  changelog: z.unknown().describe('Free-form JSON revision notes'),
};

/** A skill as the table stores it. */
export const skillRowSchema = tableRow(skills).extend(jsonColumns);

/** A skill as the services return it: the columns a client reads, never the owner or the source. */
export const skillSchema = skillRowSchema
  .pick({
    id: true,
    name: true,
    description: true,
    scope: true,
    projectId: true,
    prompt: true,
    tools: true,
    manifest: true,
    version: true,
    contentHash: true,
    skillMd: true,
    target: true,
    files: true,
    changelog: true,
    localGuide: true,
    evalScore: true,
    installOnly: true,
    basedOnGlobalSkillId: true,
    basedOnGlobalVersion: true,
    pinned: true,
    pinnedReason: true,
    pinnedBy: true,
  })
  .extend({ pinnedAt: z.union([z.date(), z.string()]).nullable() })
  .partial({
    installOnly: true,
    basedOnGlobalSkillId: true,
    basedOnGlobalVersion: true,
    pinned: true,
    pinnedReason: true,
    pinnedBy: true,
    pinnedAt: true,
  });

const listedSkillsSchema = z.array(
  skillRowSchema.extend({
    managedMeta: z.boolean().describe('A Forge-owned meta skill, served live and never synced'),
  }),
);

const invokableSchema = z.object({
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
});

const syncStatusAnswerSchema = z.array(
  z.object({
    skillId: z.string(),
    skillName: z.string(),
    target: z.enum(skillTargets).nullable(),
    scope: z.enum(skillScopes),
    currentHash: z.string(),
    currentVersion: z.number(),
    updatedAt: z.date(),
    registeredStages: z.array(z.string()),
  }),
);

const bulkPushAnswerSchema = z.object({
  results: z.array(
    z.object({ target: z.string(), status: z.literal('signalled'), deviceId: z.string() }),
  ),
  deviceCount: z.number(),
});

export { bulkPushAnswerSchema, invokableSchema, listedSkillsSchema, syncStatusAnswerSchema };

const notMember = fail('FORBIDDEN', 'the caller is not a member of the project');

/** What a body that cannot be stored refuses with, on create, update and apply-default alike. */
export const skillWriteRefusals = {
  SKILL_CONTENT_BLOCKED: 'the scanner found a blocking finding in the name, description or body',
  META_SKILL_RESERVED: 'the name belongs to a Forge meta skill',
  SKILL_LOCKED: 'the project locks this skill name against an override',
} as const;

export const listSkills = describeOperation({
  summary: 'List the global skills, and those of one project when `projectId` is sent, by name',
  description:
    '`scope=global` lists only global skills, `scope=project` needs a `projectId` and lists only the skills of that project, anything else lists both.',
  responses: {
    200: json(listedSkillsSchema, 'The skills, each flagged when it is a meta skill'),
    400: fail('BAD_REQUEST', '`scope=project` was sent without a `projectId`'),
    403: notMember,
    404: NO_SUCH_PROJECT,
  },
});

export const listInvokableSkills = describeOperation({
  summary: 'List the skills a person may run as a slash command in a chat on a project',
  description:
    'Exactly the skills `POST /api/agent-sessions/start` accepts as `skillName`, so the composer never offers one the start route would refuse.',
  responses: {
    200: json(invokableSchema, 'Name and description, sorted by name'),
    403: notMember,
    404: NO_SUCH_PROJECT,
  },
});

export const readSkill = describeOperation({
  summary: 'Read one skill',
  responses: {
    200: json(skillRowSchema),
    403: notMember,
    404: fail('NOT_FOUND', 'there is no such skill'),
  },
});

export const createSkill = describeOperation({
  summary: 'Create a skill in a project',
  description: 'A global skill cannot be created here.',
  responses: {
    201: json(skillSchema, 'The new skill'),
    400: fail({
      BAD_REQUEST: '`projectId` was not sent',
      ...skillWriteRefusals,
    }),
    403: fail('FORBIDDEN', '`isGlobal` was true, or the caller is not a project admin'),
    404: NO_SUCH_PROJECT,
  },
});

export const updateSkill = describeOperation({
  summary: 'Change a project skill; a change to its body or files raises its version',
  description: 'A global skill cannot be changed here.',
  responses: {
    200: json(skillSchema, 'The skill after the change'),
    400: fail(skillWriteRefusals),
    403: fail('FORBIDDEN', 'the skill is global, or the caller is not a project admin'),
    404: fail('NOT_FOUND', 'there is no such skill'),
  },
});

export const deleteSkill = describeOperation({
  summary: 'Delete a project skill',
  description: 'A global skill cannot be deleted here.',
  responses: {
    204: empty(),
    403: fail('FORBIDDEN', 'the skill is global, or the caller is not a project admin'),
    404: fail('NOT_FOUND', 'there is no such skill'),
  },
});

export const skillSyncStatus = describeOperation({
  summary: 'Read each skill of a project with its hash, version and registered stages',
  responses: {
    200: json(syncStatusAnswerSchema, 'Empty when the project has no skills'),
    403: notMember,
    404: NO_SUCH_PROJECT,
  },
});

export const bulkPushSkills = describeOperation({
  summary: 'Tell the device-bound runners of a project, or one device, to pull their skills',
  description:
    'Creates no job; each runner pulls its manifest and reports the hashes it installed.',
  responses: {
    200: json(
      bulkPushAnswerSchema,
      'The devices that were signalled; none when no runner is bound',
    ),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: NO_SUCH_PROJECT,
  },
});
