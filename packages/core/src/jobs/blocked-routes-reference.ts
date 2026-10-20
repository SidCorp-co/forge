import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const jobIdParamSchema = z.object({ id: z.uuid() });

export const blockedEndSchema = z.object({
  jobId: z.string(),
  status: z.literal('failed'),
  heldJobId: z.string().nullable(),
  questionIds: z.array(z.string()),
  issueId: z
    .string()
    .nullable()
    .describe(
      'The issue the question stands on: the one the job worked, else null for a project-level ask',
    ),
  replayed: z.boolean(),
});

export const endBlockedJobRoute = describeOperation({
  summary: 'End a job whose pane stopped on a question, and say what it asked',
  description:
    'The job fails and nothing retries it; the question is raised where a person reads it. Sent again for a job already ended this way it answers what the first report did, with `replayed: true`.',
  responses: {
    200: json(blockedEndSchema),
    403: fail('FORBIDDEN', 'the job is not dispatched to this device'),
    404: fail('NOT_FOUND', 'no such job'),
    409: fail('INVALID_STATE', 'the job is no longer out with a box'),
  },
});
