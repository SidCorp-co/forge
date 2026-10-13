import { z } from 'zod';
import { describeOperation, fail, json, NO_SUCH_PROJECT } from '../api-reference/describe.js';
import { jobTypes } from '../db/schema.js';

export const factsQuerySchema = z.object({
  projectId: z.uuid(),
  stage: z.enum(jobTypes).optional(),
});

export const factsSchema = z.object({
  facts: z.array(
    z.object({
      id: z.string().describe('The name a skill writes as `{{forge:<id>}}`'),
      title: z.string(),
      category: z.enum(['enum', 'protocol', 'format', 'reference']),
      tier: z.enum(['mandatory', 'contextual']),
      scope: z.enum(['global', 'project-resolved']),
      namespace: z.enum(['forge', 'project']),
      appliesTo: z
        .array(z.enum(jobTypes))
        .readonly()
        .optional()
        .describe('The stages the fact is for'),
      version: z.number(),
      preview: z.string().describe('The text as it resolves for this project'),
    }),
  ),
});

export const listSkillFacts = describeOperation({
  summary: 'List the facts a skill can reference, resolved for one project',
  description: '`stage` tailors the stage-specific facts, such as the handoff payload keys.',
  responses: {
    400: fail('BAD_REQUEST', '`projectId` is missing or not a UUID, or `stage` names no job type'),
    200: json(factsSchema, 'Every fact, with its text for this project'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: NO_SUCH_PROJECT,
  },
});
