import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { appConfig, memoryModels } from '../db/schema.js';
import { memoryReindexStates } from '../db/schema-memory-chunks.js';

export const configRowSchema = tableRow(appConfig);

/** The `memory_reindex` state as the memory-model routes answer it; null when none was ever started. */
const reindexSchema = z
  .object({
    state: z.enum(memoryReindexStates),
    total: z.number(),
    done: z.number(),
    remaining: z.number(),
    requestedAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    lastBatchAt: z.string().optional(),
    lastError: z.string().optional(),
  })
  .nullable();

export const memoryModelStateSchema = z.object({
  model: z.enum(memoryModels),
  reindex: reindexSchema,
});

export const reindexEstimateSchema = z.object({
  memories: z.number(),
  totalChars: z.number(),
  estimatedChunks: z.number(),
  estimatedEmbedCalls: z.number(),
  estimatedMinutes: z.number(),
});

const notMember = fail('FORBIDDEN', 'the caller is not a member of the project');
const notAdmin = fail('FORBIDDEN', 'the caller is not a project admin');
const noProject = fail('NOT_FOUND', 'there is no such project');

export const readAppConfig = describeOperation({
  summary: "Read a project's chat and retrieval settings",
  description: 'The body is null when the project has never saved any.',
  responses: {
    200: json(configRowSchema.nullable(), 'The settings row, or null'),
    403: notMember,
    404: noProject,
  },
});

export const putAppConfig = describeOperation({
  summary: "Change the chat and retrieval settings named in the body, creating the project's row",
  description: 'Project admins only. `chatModelByKind` replaces the whole map, so read it first.',
  responses: {
    200: json(configRowSchema, 'The settings after the change'),
    403: notAdmin,
    404: noProject,
  },
});

export const estimateMemoryModel = describeOperation({
  summary: 'What switching the project to the chunked memory model would cost',
  responses: { 200: json(reindexEstimateSchema), 403: notMember, 404: noProject },
});

export const readMemoryModel = describeOperation({
  summary: 'The memory model in force and the progress of its reindex',
  responses: { 200: json(memoryModelStateSchema), 403: notMember, 404: noProject },
});

export const flipMemoryModel = describeOperation({
  summary: 'Switch the project to the chunked or the flat memory model',
  description:
    'Chunked queues a reindex and answers 202. Flat cancels a live reindex and queues the purge of the chunks. Project admins only.',
  responses: {
    200: json(memoryModelStateSchema, 'Now flat'),
    202: json(memoryModelStateSchema, 'Now chunked, the reindex queued'),
    403: notAdmin,
    404: noProject,
    409: fail('REINDEX_LIVE', 'a reindex is already queued or running'),
  },
});

export const cancelReindex = describeOperation({
  summary: 'Cancel the queued or running reindex',
  responses: {
    200: json(memoryModelStateSchema, 'The reindex as cancelled'),
    403: notAdmin,
    404: noProject,
    409: fail('REINDEX_NOT_LIVE', 'no reindex is queued or running'),
  },
});
