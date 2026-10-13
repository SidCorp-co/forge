import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { skillRowSchema, skillSchema, skillWriteRefusals } from './crud-routes-reference.js';

/** A global skill: a read-only template, and the project skill that shadows it if any. */
const globalEntrySchema = skillRowSchema.extend({
  skillMd: z.string().describe('The body; falls back to the prompt when SKILL.md is empty'),
  editable: z.literal(false),
  shadowsGlobal: z.literal(false),
  shadowedGlobalSkillId: z.null(),
  shadowedByProjectSkillId: z.string().nullable().describe('The project skill of the same name'),
});

/** A project skill, and the global template it shadows if any. */
const projectEntrySchema = skillRowSchema.extend({
  editable: z.literal(true),
  shadowsGlobal: z.boolean(),
  shadowedGlobalSkillId: z.string().nullable(),
  shadowedByProjectSkillId: z.null(),
});

export const effectiveSkillsSchema = z.array(z.union([globalEntrySchema, projectEntrySchema]));

export const listEffectiveSkills = describeOperation({
  summary: 'List the global skills and the project skills side by side, with who shadows whom',
  description: 'Global skills come first, then the project skills, each by name; none is dropped.',
  responses: {
    200: json(effectiveSkillsSchema, 'Every global skill, then every skill of the project'),
    403: fail('FORBIDDEN', 'the caller is not a project member'),
  },
});

export const applyDefaultSkill = describeOperation({
  summary: 'Copy a global skill into the project, where it shadows the global one',
  responses: {
    201: json(skillSchema, 'The new project skill'),
    400: fail({
      BAD_REQUEST: '`globalSkillId` is not a global skill',
      ALREADY_SHADOWED: 'the project already has a skill of that name',
      META_SKILL_RESERVED: skillWriteRefusals.META_SKILL_RESERVED,
      SKILL_LOCKED: skillWriteRefusals.SKILL_LOCKED,
    }),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', 'there is no such skill'),
  },
});
