import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { pmConfig, pmDecisions, pmPolicies } from '../db/schema.js';

export const respondBody = z
  .object({
    choice: z.enum(['approve', 'defer', 'reassign', 'reject', 'free_text']),
    payload: z.record(z.string(), z.unknown()).optional(),
    comment: z.string().max(10_000).optional(),
  })
  .strict();

const eventTriggersSchema = z
  .object({
    jobFailed: z.boolean(),
    pipelineStalled: z.boolean(),
    needsInfo: z.boolean(),
    queuePressure: z.boolean(),
    graphChanged: z.boolean(),
  })
  .strict();

export const configPatchSchema = z
  .object({
    enabled: z.boolean(),
    cadenceCron: z.string().trim().min(1).max(120).nullable(),
    eventTriggers: eventTriggersSchema,
    customInstructions: z.string().trim().max(8000).nullable(),
    modelOverride: z.string().trim().min(1).max(120).nullable(),
    maxRunsPerHour: z.number().int().min(1).max(60),
  })
  .partial()
  .strict();

export const policyCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    body: z.string().trim().min(1).max(8000),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export const policyPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    body: z.string().trim().min(1).max(8000),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(1000),
  })
  .partial()
  .strict();

export const decisionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  cause: z.string().trim().min(1).max(120).optional(),
});

/** A policy as the routes answer: every column but the embedding the indexer fills in. */
export const policySchema = tableRow(pmPolicies).omit({ embedding: true });
export const policyListSchema = z.array(policySchema);
export const pmConfigSchema = tableRow(pmConfig);

const decisionSchema = tableRow(pmDecisions).pick({
  id: true,
  projectId: true,
  cause: true,
  summary: true,
  actions: true,
  confidence: true,
  modelTier: true,
  tookMs: true,
  createdAt: true,
});

export const decisionListSchema = z.object({
  items: z.array(decisionSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export const respondedSchema = z.object({
  ok: z.literal(true),
  jobId: z.string().nullable(),
  reason: z.enum(['disabled', 'trigger-masked', 'rate-limited', 'pool-job-no-prompt']).optional(),
});

const MEMBER = 'the caller is below the project member role';
const VIEWER = 'the caller is not a member of the project';
const ADMIN = 'the caller is not a project admin';

export const runPm = describeOperation({
  summary: 'Force a PM run for a project',
  description:
    'Operator spawns bypass the trigger mask and the hourly rate limit. No PM prompt is built, so a spawn that passes the guards is refused too.',
  retired:
    'nothing builds a PM prompt, so a spawn that passes its guards is refused `POOL_JOB_NO_PROMPT`',
  responses: {
    403: fail('FORBIDDEN', MEMBER),
    409: fail('DISABLED', 'the PM agent is not enabled on the project'),
    422: fail('POOL_JOB_NO_PROMPT', 'the PM run could not be started: no prompt is built for it'),
  },
});

export const respondEscalation = describeOperation({
  summary: 'Answer a PM escalation',
  description:
    'Comments on each issue the decision referenced, marks its notifications read and asks for a follow-up PM session. `jobId` is null, with `reason`, when no session was started.',
  responses: {
    200: json(respondedSchema),
    403: fail('FORBIDDEN', MEMBER),
    404: fail('NOT_FOUND', 'no such decision on the project'),
  },
});

export const readPmConfig = describeOperation({
  summary: "Read a project's PM config, creating the default row on first read",
  responses: { 200: json(pmConfigSchema), 403: fail('FORBIDDEN', VIEWER) },
});

export const updatePmConfig = describeOperation({
  summary: "Change a project's PM config",
  description: 'Only the fields sent change.',
  responses: { 200: json(pmConfigSchema, 'The config as updated'), 403: fail('FORBIDDEN', ADMIN) },
});

export const listPolicies = describeOperation({
  summary: "List a project's PM policies, highest priority first",
  responses: { 200: json(policyListSchema), 403: fail('FORBIDDEN', VIEWER) },
});

export const createPolicy = describeOperation({
  summary: 'Add a PM policy',
  responses: { 201: json(policySchema, 'The policy as created'), 403: fail('FORBIDDEN', ADMIN) },
});

export const updatePolicy = describeOperation({
  summary: 'Change a PM policy',
  description: 'Only the fields sent change.',
  responses: {
    200: json(policySchema, 'The policy as updated'),
    403: fail('FORBIDDEN', ADMIN),
    404: fail('NOT_FOUND', 'no such policy on the project'),
  },
});

export const deletePolicy = describeOperation({
  summary: 'Delete a PM policy',
  responses: {
    204: empty('Deleted'),
    403: fail('FORBIDDEN', ADMIN),
    404: fail('NOT_FOUND', 'no such policy on the project'),
  },
});

export const listDecisions = describeOperation({
  summary: "List a project's PM decisions, newest first",
  description: 'Paged by `page` and `pageSize`; `cause` filters to one cause.',
  responses: { 200: json(decisionListSchema), 403: fail('FORBIDDEN', VIEWER) },
});
