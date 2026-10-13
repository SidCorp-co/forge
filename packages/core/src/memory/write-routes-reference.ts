import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';

export const writeResultSchema = z.object({
  id: z.string(),
  embeddedAt: z.date(),
  truncated: z.boolean().describe('The text was cut before embedding; the stored text is whole'),
  degraded: z.boolean(),
  nearDuplicateOf: z
    .string()
    .optional()
    .describe(
      '`sourceRef` of a same-source entry with near-identical text; the write still landed',
    ),
  dedupeScore: z.number().optional().describe('Set only with `nearDuplicateOf`'),
});

export const feedbackResultSchema = z.object({
  found: z.boolean(),
  action: z.enum(['verified', 'archived', 'noop']),
});

const notMember = fail('FORBIDDEN', 'the caller is not a member of the project');

export const writeMemory = describeOperation({
  summary: 'Write a memory entry; the same source and reference replaces the earlier text',
  responses: {
    201: json(writeResultSchema, 'Where the entry landed'),
    400: fail('BAD_REQUEST', 'the text is not one the indexer can store'),
    403: notMember,
    503: fail('EMBEDDING_UNAVAILABLE', 'the embeddings service is down'),
  },
});

export const memoryFeedback = describeOperation({
  summary: 'Report whether a memory hit still held against live code',
  description:
    'A `confirmed` verdict refreshes the entry and an `outdated` one, which needs `evidence`, archives it. A missing entry answers 404 with the same body and `action: noop`.',
  responses: {
    200: json(feedbackResultSchema, 'What the verdict did'),
    400: fail('BAD_REQUEST', 'an `outdated` verdict came without `evidence`'),
    403: notMember,
    404: json(feedbackResultSchema, 'No such entry: `found` is false'),
  },
});
