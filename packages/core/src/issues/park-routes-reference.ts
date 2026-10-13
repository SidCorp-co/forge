import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { issueStatuses } from '../db/schema.js';

const parkSchema = z.object({
  shape: z.enum(['park', 'question']),
  status: z.enum(issueStatuses),
  owes: z.enum(['information', 'decision', 'resource']).nullable(),
  since: z.string().nullable(),
  reason: z.string().nullable(),
  resume: z.union([
    z.object({ at: z.enum(issueStatuses), recordId: z.string() }),
    z.object({ at: z.null(), why: z.string() }),
  ]),
  record: z
    .object({
      commentId: z.string(),
      kind: z.string().nullable(),
      why: z.string().nullable(),
      postedAt: z.string(),
    })
    .nullable(),
  readings: z.array(z.string()),
  answer: z.object({ commentId: z.string(), postedAt: z.string(), text: z.string() }).nullable(),
  openQuestionIds: z.array(z.string()),
});

export const issueParkSchema = z.object({ park: parkSchema.nullable() });

export const readIssuePark = describeOperation({
  summary: 'Read what a person owes this issue, and where it resumes, or `park: null`',
  responses: {
    200: json(issueParkSchema),
    403: fail('FORBIDDEN', "the caller is not a member of the issue's project"),
    404: fail('NOT_FOUND', 'the issue does not exist'),
  },
});
