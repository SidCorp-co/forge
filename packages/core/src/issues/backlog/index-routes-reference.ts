import { z } from 'zod';
import { describeOperation, fail, json } from '../../api-reference/describe.js';

const indexStateSchema = z.object({
  state: z.enum(['fresh', 'stale']),
  pending: z.number(),
  lapsed: z.number().optional(),
  oldestPendingAt: z.string().nullable(),
});

const numberTable = z.record(z.string(), z.number());

const rankedIssueSchema = z.object({
  issueId: z.string(),
  displayId: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  category: z.string().nullable(),
  complexity: z.string().nullable(),
  createdAt: z.string(),
  score: z.object({
    total: z.number(),
    parts: z.array(z.object({ name: z.string(), said: z.string(), points: z.number() })),
  }),
  chained: z.number(),
  eligible: z.boolean(),
  blockedBy: z.array(
    z.object({
      issueId: z.string(),
      displayId: z.string(),
      status: z.string(),
      holdsUntil: z.string(),
      validUntil: z.string().nullable(),
    }),
  ),
  lease: z
    .object({
      holder: z.string().nullable(),
      renewedAt: z.string().nullable(),
      minutes: z.number().nullable(),
      live: z.boolean(),
    })
    .nullable(),
});

export const rankingSchema = z.object({
  order: z.array(rankedIssueSchema),
  takeable: z.number(),
  eligible: z.number(),
  weights: z.object({
    value: z.object({
      priority: numberTable,
      kind: numberTable,
      complexity: numberTable,
      module: numberTable,
      agePerDay: z.number(),
      ageCap: z.number().nullable(),
      reopened: z.number(),
      blocks: z.number(),
      reading: z.number(),
      similarity: z.number(),
      batchCap: z.number(),
    }),
    from: z.enum(['built-in', 'project']),
  }),
  index: indexStateSchema,
  edges: z.literal('tracker'),
  excluded: z.array(z.object({ term: z.string(), why: z.string() })).readonly(),
});

export const neighboursSchema = z.object({
  seeds: z.array(
    z.object({
      issueId: z.string(),
      displayId: z.string(),
      title: z.string(),
      measuredAt: z.string(),
      stale: z.boolean(),
      hits: z.array(
        z.object({
          memoryId: z.string(),
          sourceRef: z.string(),
          score: z.number(),
          stale: z.boolean(),
        }),
      ),
    }),
  ),
  total: z.number(),
  topK: z.number(),
  next: z.number().nullable(),
  index: indexStateSchema,
});

const NOT_A_MEMBER = fail('FORBIDDEN', 'the caller is not a member of the project');
const UNKNOWN_QUERY = {
  UNKNOWN_QUERY_PARAMETER:
    'a query parameter this route does not take; details lists the ones it does',
};

export const readRankingRoute = describeOperation({
  summary: "Rank a project's takeable issues best first, from the stored scores",
  description:
    'Catches up what is pending for up to `catchUpMs` before answering. `eligible` leaves out issues a live blocking edge holds back. The score of each issue is in parts, so the order can be audited.',
  responses: {
    200: json(rankingSchema),
    400: fail(UNKNOWN_QUERY),
    403: NOT_A_MEMBER,
    409: fail({
      RANK_WEIGHTS_REFUSED: "the project's stored weight table cannot rank; details names the key",
      RANK_INDEX_INCOMPLETE:
        'the ranking index does not cover every takeable issue yet, so ask again',
    }),
  },
});

export const readNeighboursRoute = describeOperation({
  summary: 'For every unsettled issue, the nearest issues to it, a page at a time',
  description: '`next` is the `after` that continues the read, null where the page ends it.',
  responses: {
    200: json(neighboursSchema),
    400: fail(UNKNOWN_QUERY),
    403: NOT_A_MEMBER,
    409: fail(
      'ALIKE_INDEX_INCOMPLETE',
      'the neighbours index has not measured every unsettled issue yet, so ask again',
    ),
  },
});
