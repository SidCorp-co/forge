import { z } from 'zod';
import {
  describeOperation,
  fail,
  json,
  NO_SUCH_PROJECT,
} from '../api-reference/declare/describe.js';
import { issuePriorities, issueStatuses } from '../db/schema.js';
import { BATCH_SKIP_BY_CODE } from './batch-skip-reason.js';
import { ISSUE_REF_REFUSALS } from './search-reference.js';
import type { TransitionErrorCode } from './transition-error.js';
import { rewrittenSchema } from './transition-reference.js';

export const batchPatchBodySchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(100),
    data: z
      .object({
        status: z.enum(issueStatuses).optional(),
        priority: z.enum(issuePriorities).optional(),
        category: z.string().trim().min(1).max(100).nullable().optional(),
        reason: z
          .string()
          .trim()
          .max(2000)
          .optional()
          .describe(
            'Why the status moves, sent once and posted on every issue it moves. A move into `on_hold`, `waiting`, `needs_info` or `reopen` skips an issue as `transition_reason_required` without one.',
          ),
      })
      .strict()
      .refine((o) => Object.keys(o).filter((k) => k !== 'reason').length > 0, {
        message: 'no fields to update',
      })
      .refine((o) => o.reason === undefined || o.status !== undefined, {
        message: '`reason` travels with a `status` move and is refused without one',
        path: ['reason'],
      }),
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
      rewritten: rewrittenSchema.optional(),
    }),
  ),
  skipped: z.array(
    z.object({
      id: z.string(),
      reason: skipReasonSchema,
      code: z
        .enum(Object.keys(BATCH_SKIP_BY_CODE) as [TransitionErrorCode, ...TransitionErrorCode[]])
        .optional()
        .describe(
          'Set where a status move was refused: the code every other door answers it with.',
        ),
      message: z
        .string()
        .optional()
        .describe(
          'Set where a status move was refused: the sentence saying why, and what to do instead.',
        ),
      detail: z
        .string()
        .optional()
        .describe('Set when a refused status move left the fields sent beside it unwritten.'),
    }),
  ),
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
    'Never refused as a whole: each issue lands in `updated`, `skipped` or `failed`. The priority and category of an issue are written in the same transaction as its status move: a move the state machine refused skips that issue under its reason and writes nothing else for it.',
  responses: { 200: json(batchResultSchema), 404: NO_SUCH_PROJECT },
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
