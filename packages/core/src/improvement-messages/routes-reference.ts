import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const improvementMessageSchema = z.object({
  key: z.string(),
  title: z.string(),
  message: z.string(),
  rationale: z.string(),
  appliesToSkills: z.array(z.string()).readonly().optional(),
  appliesWhen: z.string().optional(),
  category: z.enum([
    'code-quality',
    'testing',
    'documentation',
    'performance',
    'security',
    'dx',
    'ops',
    'pipeline-correctness',
    'quality',
    'steward',
    'general',
  ]),
  version: z.number(),
  recommended: z.boolean(),
  defaultMode: z.enum(['propose', 'auto']),
  standing: z.boolean().optional(),
  enablement: z
    .object({
      enabled: z.boolean(),
      scheduleId: z.string(),
      mode: z.string(),
      cron: z.string(),
    })
    .nullable(),
});

export const listImprovementMessages = describeOperation({
  summary: 'The catalog of scheduled improvement messages, with the project schedule enabling each',
  description:
    '`enablement` is null for every entry unless a `projectId` is sent and has a schedule for it.',
  responses: {
    200: json(z.array(improvementMessageSchema)),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'there is no such project'),
  },
});
