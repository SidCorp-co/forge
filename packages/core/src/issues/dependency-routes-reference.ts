import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { dependencyEdgesSchema, ISSUE_REF_REFUSALS } from './search-reference.js';

export const dependencyWrittenSchema = z.object({
  id: z.string(),
  created: z.boolean(),
  updated: z.boolean().optional(),
  effects: z.object({
    gatesDispatch: z.boolean(),
    waivesWorkEvidence: z.boolean(),
    note: z.string(),
  }),
});

export const dependencyRemovedSchema = z.object({ deleted: z.literal(true) });

export const readDependencies = describeOperation({
  summary: 'List the edges an issue is on either end of',
  description:
    '`outgoing` are edges where this issue is the `from` side, which blocks or relates to others; `incoming` are edges where it is the `to` side.',
  responses: { 200: json(dependencyEdgesSchema), ...ISSUE_REF_REFUSALS },
});

export const addDependency = describeOperation({
  summary: 'Declare that this issue depends on another',
  description:
    'Stored as the edge from `dependsOnId` to this issue. Idempotent on the edge: one that stands is updated and answered with 200. A `validUntil` in the past retracts it.',
  responses: {
    201: json(dependencyWrittenSchema, 'The edge was created'),
    200: json(
      dependencyWrittenSchema,
      'The edge stood already; `updated` says whether this call changed it',
    ),
    400: fail({
      SELF_DEP: 'an issue cannot depend on itself',
      CROSS_PROJECT: 'the two issues are in different projects',
      HOLD_NEEDS_BLOCKS: '`holdsUntil` was sent on an edge that is not `blocks`',
    }),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'one or both issues do not exist'),
    409: fail({
      CYCLE_DETECTED: 'the edge would close a loop of blocking issues',
      CYCLE_DEPTH_EXCEEDED: 'the blocking chain is too deep to check for a loop',
      ISSUE_ARCHIVED: 'one of the issues is archived',
    }),
  },
});

export const removeDependency = describeOperation({
  summary: 'Delete an edge of this issue',
  responses: {
    200: json(dependencyRemovedSchema),
    400: fail('EDGE_MISMATCH', 'the edge is not on this issue'),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the edge does not exist'),
  },
});
