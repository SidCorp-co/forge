import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { jobStatuses, jobs, jobTypes, modelTiers } from '../db/schema.js';
import { paginationSchema } from '../lib/pagination.js';
import { POOL_JOB_NO_PROMPT } from './pool-served.js';

export const jobCreateSchema = z
  .object({
    type: z.enum(jobTypes),
    payload: z.record(z.string(), z.unknown()).optional(),
    issueId: z.uuid().nullable().optional(),
    modelTier: z.enum(modelTiers).nullable().optional(),
  })
  .strict();

export const jobPatchSchema = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
    modelTier: z.enum(modelTiers).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

export const jobListFiltersSchema = paginationSchema.extend({
  status: z.enum(jobStatuses).optional(),
  type: z.enum(jobTypes).optional(),
  issueId: z.uuid().optional(),
});

export const projectIdParamSchema = z.object({ id: z.uuid() });
export const jobIdParamSchema = z.object({ id: z.uuid() });

export const jobRowSchema = tableRow(jobs);

export const jobListSchema = z.object({
  items: z.array(jobRowSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export const jobDetailSchema = jobRowSchema.extend({
  device: z.object({ id: z.string(), name: z.string(), status: z.string() }).nullable(),
});

const resolvedFlagsSchema = z.object({
  state: z.string().nullable(),
  skillName: z.string().nullable(),
  model: z.string().nullable(),
  allowedTools: z.string().nullable(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).nullable(),
  timeoutSeconds: z.number().nullable(),
  claudeSessionId: z.string().nullable(),
  systemPromptMode: z.enum(['append', 'replace']).nullable(),
});

/** The prompt a job was dispatched with, as the Inspector shows it. */
export const promptEnvelopeSchema = z.object({
  jobId: z.string(),
  systemPrompt: z.string().nullable(),
  systemPromptHash: z.string().nullable(),
  userPrompt: z.string().nullable(),
  blocks: z.array(z.unknown()),
  estTokens: z.object({ input: z.number().nullable() }),
  actualUsage: z
    .object({
      input: z.number(),
      output: z.number(),
      cached: z.number(),
      cacheCreation: z.number(),
      cost: z.number(),
      count: z.number(),
    })
    .nullable(),
  mcpConfig: z.unknown().describe("The job's MCP server map with header secrets redacted, or null"),
  model: z.string().nullable(),
  payloadExtras: z.record(z.string(), z.unknown()),
  resolvedFlags: resolvedFlagsSchema,
});

export const archivedPromptSchema = z.object({ archived: z.literal(true), path: z.string() });

const notMember = fail('FORBIDDEN', "the caller is not a member of the job's project");

export const createJob = describeOperation({
  summary: 'Queue a job on a project, optionally against one of its issues',
  description:
    "The payload must carry a prompt. A job with an issue joins the issue's open run; one without gets a run of its own.",
  responses: {
    201: json(jobRowSchema, 'The queued job'),
    400: fail('BAD_REQUEST', '`issueId` names no issue, or one in another project'),
    403: notMember,
    404: fail('NOT_FOUND', 'no such project'),
    422: fail(POOL_JOB_NO_PROMPT, 'the payload carries no prompt for the job to run'),
  },
});

export const listProjectJobs = describeOperation({
  summary: "List a project's jobs, newest queued first, optionally by status, type or issue",
  description: 'The total across pages is also sent in the `X-Total-Count` header.',
  responses: {
    200: json(jobListSchema),
    403: notMember,
    404: fail('NOT_FOUND', 'no such project'),
  },
});

export const readJobDetail = describeOperation({
  summary: 'Read one job with the device that ran it',
  responses: {
    200: json(jobDetailSchema),
    403: notMember,
    404: fail('NOT_FOUND', 'no such job'),
  },
});

export const patchQueuedJob = describeOperation({
  summary: "Change a queued job's payload or model tier",
  responses: {
    200: json(jobRowSchema, 'The job after the change'),
    403: notMember,
    404: fail('NOT_FOUND', 'no such job'),
    409: fail('JOB_NOT_QUEUED', 'the job has left the queue'),
  },
});

export const readJobPrompt = describeOperation({
  summary: 'Read the prompt a job was dispatched with, with usage rolled up',
  responses: {
    200: json(promptEnvelopeSchema),
    403: notMember,
    404: fail('NOT_FOUND', 'no such job, or its prompt snapshot was never stored'),
    410: json(archivedPromptSchema, 'The snapshot was archived; `path` says where'),
  },
});
