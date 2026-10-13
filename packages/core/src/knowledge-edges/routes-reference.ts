import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { knowledgeEdges } from '../db/schema.js';

export const knowledgeEdgeSchema = tableRow(knowledgeEdges);
export const knowledgeEdgeListSchema = z.array(knowledgeEdgeSchema);

export const listKnowledgeEdges = describeOperation({
  summary: "List a project's knowledge edges (subject, predicate, object), newest first",
  responses: {
    200: json(knowledgeEdgeListSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const createKnowledgeEdge = describeOperation({
  summary: 'Record a knowledge edge; an identical triple already held is returned, not duplicated',
  responses: {
    200: json(knowledgeEdgeSchema, 'The identical edge that was already held'),
    201: json(knowledgeEdgeSchema, 'The edge created'),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const deleteKnowledgeEdge = describeOperation({
  summary: 'Delete a knowledge edge',
  responses: {
    204: empty(),
    403: fail('FORBIDDEN', "the caller is not an admin of the edge's project"),
    404: fail('NOT_FOUND', 'the edge does not exist, or its project does not'),
  },
});
