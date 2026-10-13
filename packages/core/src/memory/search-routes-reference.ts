import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { memorySources } from '../db/schema.js';
import { memorySearchStrategies } from './search-service.js';

const hitSchema = z.object({
  id: z.string(),
  source: z.enum(memorySources),
  sourceRef: z.string(),
  text: z.string(),
  metadata: z.unknown().describe('Free-form JSON the writer attached to the entry'),
  score: z.number().describe('Similarity, or the fused rank value for a hybrid search'),
  embeddedAt: z.date(),
  stale: z.boolean().describe('A later release may have contradicted the entry'),
  supersededBy: z.string().optional().describe('`ISS-<n>`; present only with `stale`'),
  rerankPosition: z.number().optional().describe('Present only when `reranked` is true'),
  via: z
    .object({ relation: z.enum(['blocks', 'relates']), from: z.string() })
    .optional()
    .describe('Present on an entry appended because it neighbours a hit, not retrieved'),
  matchedChunk: z
    .object({ index: z.number(), text: z.string() })
    .optional()
    .describe('The passage that matched, on a chunked project'),
});

export const searchResultSchema = z.object({
  hits: z.array(hitSchema),
  model: z.string(),
  took_ms: z.number(),
  embedMs: z.number().optional().describe('Absent when no query embedding was made here'),
  strategy: z.enum(memorySearchStrategies).describe('The strategy that ran'),
  degraded: z.boolean().optional().describe('A hybrid search fell back to keyword'),
  reranked: z.boolean().describe('The hits are in the order the fast model gave'),
  rerankHoldout: z.literal(true).optional(),
  expanded: z.boolean().describe('Neighbours of the hits were appended'),
  demotedStale: z.number().optional().describe('Hits moved below the fresh ones'),
});

export const searchMemories = describeOperation({
  summary: "Search a project's memory by meaning, by keyword or both",
  responses: {
    200: json(searchResultSchema, 'The hits, best first'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    503: fail('EMBEDDING_UNAVAILABLE', 'the embeddings service is down and the strategy needs it'),
  },
});
