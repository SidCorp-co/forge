import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { memorySources } from '../db/memory-vocabulary.js';
import { issueStatuses } from '../db/schema.js';
import { masterVerbs } from '../db/schema-master-charter.js';

const readWhenSchema = z
  .object({
    verbs: z.array(z.enum(masterVerbs)).optional(),
    statuses: z.array(z.enum(issueStatuses)).optional(),
  })
  .nullable();

const entryFields = {
  id: z.string(),
  slug: z.string(),
  kind: z.string(),
  title: z.string(),
  injection: z.string(),
  confidence: z.string(),
  authoredBy: z.string(),
  orderIndex: z.number(),
  updatedAt: z.date(),
  readWhen: readWhenSchema,
};

export const knowledgeListSchema = z.object({
  rows: z.array(z.object(entryFields)),
  truncated: z.boolean(),
  returned: z.number(),
  total: z.number(),
  maxAlwaysInjectChars: z.number(),
  alwaysInjectGuarantee: z.string(),
});

export const knowledgeEntrySchema = z.object({
  ...entryFields,
  body: z.string(),
  metadata: z.unknown(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
});

export const knowledgeSearchSchema = z.object({
  knowledge: z.array(
    z.object({
      origin: z.literal('knowledge'),
      id: z.string(),
      slug: z.string(),
      kind: z.string(),
      title: z.string(),
      body: z.string(),
      injection: z.string(),
      confidence: z.string(),
      score: z.number(),
    }),
  ),
  memory: z.array(
    z.object({
      origin: z.literal('memory'),
      id: z.string(),
      source: z.enum(memorySources),
      sourceRef: z.string(),
      text: z.string(),
      metadata: z.unknown(),
      score: z.number(),
      embeddedAt: z.date(),
      stale: z.boolean(),
      supersededBy: z.string().optional(),
      rerankPosition: z.number().optional(),
      via: z.object({ relation: z.enum(['blocks', 'relates']), from: z.string() }).optional(),
      matchedChunk: z.object({ index: z.number(), text: z.string() }).optional(),
    }),
  ),
  degraded: z.boolean().optional(),
});

export const knowledgeUpsertSchema = z.object({
  id: z.string(),
  slug: z.string(),
  degraded: z.boolean(),
  truncated: z.boolean(),
});

export const knowledgeDeletedSchema = z.object({ deleted: z.boolean() });

export const knowledgeIngestSchema = z.object({
  ok: z.literal(true),
  processed: z.number(),
  totalChunks: z.number(),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});

const NOT_A_MEMBER = fail('FORBIDDEN', 'the caller is not a member of the project');

export const listKnowledge = describeOperation({
  summary: "List a project's knowledge entries without their bodies",
  description:
    '`verb` and `status` match an entry whose `readWhen` names either; a value that is not a verb or a status is refused naming the valid ones.',
  responses: { 200: json(knowledgeListSchema), 403: NOT_A_MEMBER },
});

export const searchKnowledge = describeOperation({
  summary: "Search a project's knowledge and, by scope, its memory",
  description:
    'Each store is searched on its own and scores are not blended. `degraded` is set when embeddings were unavailable and a keyword search answered.',
  responses: {
    200: json(knowledgeSearchSchema),
    403: NOT_A_MEMBER,
    503: fail('EMBEDDING_UNAVAILABLE', 'the embeddings service is unavailable'),
  },
});

export const getKnowledge = describeOperation({
  summary: 'Read one knowledge entry by slug',
  description: 'A slug is kebab-case with no slash; anything else is refused naming the rule.',
  responses: {
    200: json(knowledgeEntrySchema),
    403: NOT_A_MEMBER,
    404: fail('NOT_FOUND', 'the project has no entry with this slug'),
  },
});

export const putKnowledge = describeOperation({
  summary: 'Create or replace a knowledge entry by slug',
  description:
    'An entry written while embeddings are down is stored without a vector (`degraded`) and filled in later.',
  responses: {
    200: json(knowledgeUpsertSchema),
    400: fail(
      'KNOWLEDGE_READ_WHEN_SHAPE',
      '`readWhen` is not a verb or status condition; details.field names the field',
    ),
    403: NOT_A_MEMBER,
    503: fail('EMBEDDING_UNAVAILABLE', 'the embeddings service is unavailable'),
  },
});

export const deleteKnowledge = describeOperation({
  summary: 'Delete a knowledge entry by slug',
  description: '`deleted` is false when no entry had the slug.',
  responses: { 200: json(knowledgeDeletedSchema), 403: NOT_A_MEMBER },
});

export const ingestKnowledge = describeOperation({
  summary: 'Import up to 20 documents as reference entries',
  description:
    'A document over 50 KB or empty is listed in `skipped` with its reason; a failed index write skips every accepted document as `index_failed`.',
  responses: {
    200: json(knowledgeIngestSchema),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the project does not exist'),
    429: fail('RATE_LIMIT_EXCEEDED', 'the project has had 100 ingest requests in the last minute'),
  },
});
