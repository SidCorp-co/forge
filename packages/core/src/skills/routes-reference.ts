import { z } from 'zod';
import { describeOperation, fail, json, NO_SUCH_PROJECT } from '../api-reference/describe.js';
import { issueStatuses } from '../db/schema.js';

const stageSchema = z.enum(issueStatuses);

export const syncResultSchema = z.object({
  added: z.array(z.string()),
  updated: z.array(z.string()),
  unchanged: z.array(z.string()),
  removed: z.array(z.string()),
});

export const registeredSchema = z.object({
  projectId: z.string(),
  skillId: z.string(),
  stage: stageSchema.nullable().describe('Null when the skill was unregistered'),
});

export const registrationsSchema = z.object({
  registrations: z.array(
    z.object({
      stage: z.string().describe('An issue status'),
      skillId: z.string(),
      skillName: z.string(),
      skillScope: z.enum(['global', 'project']),
      registeredBy: z.string().nullable(),
      createdAt: z.date(),
    }),
  ),
});

export const unregisteredSchema = z.object({
  deleted: z.boolean().describe('False when no skill was registered to the stage'),
  stage: stageSchema,
});

const notMember = fail('FORBIDDEN', 'the caller is not a member of the project');
const notAdmin = fail('FORBIDDEN', 'the caller is not a project admin');

export const syncProjectSkills = describeOperation({
  summary: 'Push the skills a device holds for a project and get what changed',
  description:
    'A `partial` push adds and updates only the skills sent; a `full` push also removes the project skills it omits, and needs a device owned by a project admin.',
  responses: {
    200: json(syncResultSchema, 'The skill names added, updated, left alone and removed'),
    403: fail(
      'FORBIDDEN',
      'the owner of the device is not a project member, a `full` push came from a device whose owner is not an admin, or a skill name is a Forge meta skill',
    ),
  },
});

export const registerSkill = describeOperation({
  summary: 'Bind a project skill to a pipeline stage, or unbind it with a null stage',
  responses: {
    200: json(registeredSchema, 'The binding after the change'),
    400: fail(
      'SKILL_NOT_PROJECT_SCOPED',
      'the skill is global or belongs to another project; adopt the global template first',
    ),
    403: notAdmin,
    404: fail('NOT_FOUND', 'there is no such skill for the project'),
  },
});

export const listSkillRegistrations = describeOperation({
  summary: 'List the stage-to-skill bindings of a project',
  responses: {
    200: json(registrationsSchema, 'One row per bound stage'),
    403: notMember,
    404: NO_SUCH_PROJECT,
  },
});

export const unregisterStage = describeOperation({
  summary: 'Clear the skill bound to one stage, whichever skill it is',
  responses: {
    200: json(unregisteredSchema, 'Whether a binding was cleared'),
    403: notAdmin,
    404: NO_SUCH_PROJECT,
  },
});
