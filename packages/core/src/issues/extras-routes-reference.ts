import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { issuePriorities, issueStatuses } from '../db/schema.js';
import { BATCH_SKIP_BY_CODE } from './batch-skip-reason.js';
import { ISSUE_REF_REFUSALS } from './search-reference.js';
import { rewrittenSchema } from './transition-reference.js';

export const batchPatchBodySchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(100),
    data: z
      .object({
        status: z.enum(issueStatuses).optional(),
        priority: z.enum(issuePriorities).optional(),
        category: z.string().trim().min(1).max(100).nullable().optional(),
      })
      .strict()
      .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' }),
  })
  .strict();

export const pipelineTimingQuerySchema = z
  .object({
    projectId: z.uuid(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .strict();

const skipReasonSchema = z.literal([
  'forbidden',
  'not_found',
  ...Object.values(BATCH_SKIP_BY_CODE),
]);

export const batchResultSchema = z.object({
  updated: z.array(
    z.object({
      id: z.string(),
      displayId: z.string(),
      skipReason: skipReasonSchema.optional(),
      rewritten: rewrittenSchema.optional(),
    }),
  ),
  skipped: z.array(z.object({ id: z.string(), reason: skipReasonSchema })),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});

export type BatchResult = z.input<typeof batchResultSchema>;

export const pipelineTimingSchema = z.object({
  projectId: z.string(),
  stats: z.array(
    z.object({
      status: z.string(),
      sampleCount: z.number(),
      avgMs: z.number(),
      medianMs: z.number(),
      p90Ms: z.number(),
    }),
  ),
});

export const costSummarySchema = z.object({
  issueId: z.string(),
  projectId: z.string(),
  estimatedCost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  requests: z.number(),
  sampleCount: z.number(),
});

export const runPipelineStepAnswerSchema = z.object({
  issueId: z.string(),
  status: z.literal('awaiting_release'),
});

export const patchIssuesBatch = describeOperation({
  summary: 'Change the status, priority or category of up to 100 issues at once',
  description:
    'Never refused as a whole: each issue lands in `updated`, `skipped` or `failed`. A status move the state machine refused is named in `skipReason` when other fields were still written.',
  responses: { 200: json(batchResultSchema) },
});

export const enrichIssue = describeOperation({
  summary: 'Ask for an enrichment run of an issue',
  retired: 'no enrichment prompt is built anywhere, so no job is ever minted',
  responses: {
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the issue does not exist'),
    422: fail(
      'POOL_JOB_NO_PROMPT',
      'no enrichment prompt is built anywhere, so there is nothing to run',
    ),
  },
});

export const runPipelineStep = describeOperation({
  summary: "Start the pipeline step for the issue's status by hand",
  responses: {
    202: json(runPipelineStepAnswerSchema, 'The step was queued'),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the issue does not exist'),
    409: fail({
      JOB_ALREADY_ACTIVE: 'a job of this step is already running for the issue',
      NOT_AT_ENTRY_STATUS:
        "an autonomous project's driver is only handed an issue at its entry status",
    }),
  },
});

export const readPipelineTiming = describeOperation({
  summary: 'How long issues dwell in each status, from the status changes of a project',
  description: 'Average, median and 90th percentile in milliseconds per status.',
  responses: {
    200: json(pipelineTimingSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const readCostSummary = describeOperation({
  summary: "Total the estimated cost and tokens of an issue's sessions",
  responses: { 200: json(costSummarySchema), ...ISSUE_REF_REFUSALS },
});
