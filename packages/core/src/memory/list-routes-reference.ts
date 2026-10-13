import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';
import { memorySources } from '../db/schema.js';

const memorySourceSchema = z.enum(memorySources);

/** A memory row as the list reads it: the embedding is never sent. */
const memoryRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  source: memorySourceSchema,
  sourceRef: z.string(),
  textContent: z.string(),
  metadata: z.unknown().describe('Free-form JSON the writer attached to the entry'),
  embeddedAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
  archivedAt: z.date().nullable().describe('Set only on a row that decay archived'),
});

const revisionRowSchema = z.object({
  id: z.string(),
  memoryId: z.string(),
  source: memorySourceSchema,
  sourceRef: z.string(),
  textContent: z.string().describe('The body a later write replaced'),
  metadata: z.unknown().describe('Free-form JSON the replaced body carried'),
  replacedAt: z.date(),
});

const envelope = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    returned: z.number(),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  });

export const memoryListSchema = envelope(memoryRowSchema);
export const memoryRevisionListSchema = envelope(revisionRowSchema);
export const memoryDeletedSchema = z.object({
  deleted: z.number().describe('How many rows the delete removed'),
});

const notMember = fail('FORBIDDEN', 'the caller is not a member of the project');

export const listMemories = describeOperation({
  summary: "List a project's memory entries, newest first, by source or reference",
  description:
    'Rows decay archived and the rows of archived issues are left out unless `includeArchived=true`.',
  responses: { 200: json(memoryListSchema, 'One page of entries'), 403: notMember },
});

export const listMemoryRevisions = describeOperation({
  summary: 'List the bodies later writes replaced, newest replacement first',
  responses: { 200: json(memoryRevisionListSchema, 'One page of replaced bodies'), 403: notMember },
});

export const deleteMemoriesBySource = describeOperation({
  summary: 'Delete the entry of one source and reference',
  responses: { 200: json(memoryDeletedSchema, 'How many rows were deleted'), 403: notMember },
});

export const deleteMemoryById = describeOperation({
  summary: 'Delete one memory entry by id',
  description:
    'Answers 204 whether or not the entry existed and whether or not the caller may delete it, so the answer never reveals an entry in a project the caller cannot see; only a member sees it removed.',
  responses: { 204: empty('Done, or nothing was deleted') },
});
