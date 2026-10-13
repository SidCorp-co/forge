import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';

const SCOPE =
  'Reads the projects the caller can see; `projectId` narrows to one, and a project the caller cannot see reads as no data.';

export const throughputSchema = z.array(
  z.object({ projectId: z.string(), date: z.string(), count: z.number() }),
);

export const cycleTimeSchema = z.array(
  z.object({ status: z.string(), avgHours: z.number(), n: z.number() }),
);

export const stepDurationsSchema = z.array(
  z.object({
    runId: z.string(),
    issueId: z.string().nullable(),
    projectId: z.string(),
    step: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    durationSeconds: z.number(),
    costUsd: z.number(),
    deviceId: z.string().nullable(),
    modelUsed: z.string().nullable(),
  }),
);

export const retryRescuesSchema = z.object({
  total: z.number(),
  reasons: z.array(
    z.object({
      projectId: z.string(),
      failureKind: z.string().nullable(),
      failureReason: z.string(),
      rescues: z.number(),
      lastRescuedAt: z.string(),
    }),
  ),
});

export const interventionsSchema = z.object({
  total: z.number(),
  byIssue: z.array(
    z.object({
      issueId: z.string().nullable(),
      projectId: z.string(),
      wedges: z.number(),
      manualJobActions: z.number(),
      userRunFlips: z.number(),
      directSql: z.number(),
      total: z.number(),
      lastAt: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      source: z.union([
        z.enum(['wedge', 'user_run_flip', 'direct_sql']),
        z.templateLiteral(['manual_', z.string()]),
      ]),
      projectId: z.string(),
      issueId: z.string().nullable(),
      occurredAt: z.string(),
      detail: z.string().nullable(),
    }),
  ),
});

export const driverComparisonSchema = z.object({
  days: z.number(),
  projects: z.array(
    z.object({
      projectId: z.string(),
      driver: z.enum(['autonomous', 'staged']),
      issuesClosed: z.number(),
      issuesDropped: z.number(),
      interventions: z.number(),
      interventionsPerIssueClosed: z.number().nullable(),
      medianRequestToRunningSeconds: z.number().nullable(),
      p95RequestToRunningSeconds: z.number().nullable(),
      medianDriverWaitSeconds: z.number().nullable(),
      p95DriverWaitSeconds: z.number().nullable(),
      issuesBornUnderDriver: z.number(),
    }),
  ),
});

export const costSummarySchema = z.object({
  total: z.number(),
  byState: z.array(
    z.object({ state: z.string(), total: z.number(), runs: z.number(), avgPerRun: z.number() }),
  ),
  byIssue: z.array(z.object({ issueId: z.string(), total: z.number() })),
});

export const costTrendSchema = z.object({
  daily: z.array(z.object({ date: z.string(), cost: z.number(), runs: z.number() })),
  annotations: z.array(
    z.object({ ts: z.string(), message: z.string(), kind: z.literal('pipeline_config.updated') }),
  ),
});

export const outliersSchema = z.object({
  threshold: z.number(),
  runs: z.array(
    z.object({
      jobId: z.string(),
      state: z.string(),
      cost: z.number(),
      issueId: z.string().nullable(),
      dimensions: z.object({ descriptionLen: z.number(), sessionDepth: z.number() }),
    }),
  ),
});

export const readThroughput = describeOperation({
  summary: 'Issues shipped per project per UTC day over the last `days`',
  description: `One row per project per calendar day, a day with nothing shipped included at 0. ${SCOPE}`,
  responses: { 200: json(throughputSchema) },
});

export const readCycleTime = describeOperation({
  summary: 'Average hours issues spend in each status before moving on',
  description: `Only transitions that both fall inside the window count. ${SCOPE}`,
  responses: { 200: json(cycleTimeSchema) },
});

export const readStepDurations = describeOperation({
  summary: 'Per-step run durations and cost, newest first, at most 1000 rows',
  description: `Narrow to one job type with \`step\`. ${SCOPE}`,
  responses: { 200: json(stepDurationsSchema) },
});

export const readRetryRescues = describeOperation({
  summary: 'Failures a later retry rescued, grouped by failure reason',
  description: SCOPE,
  responses: { 200: json(retryRescuesSchema) },
});

export const readInterventions = describeOperation({
  summary: 'Human interventions on the pipeline: wedges, manual job actions, run flips, direct SQL',
  description: SCOPE,
  responses: { 200: json(interventionsSchema) },
});

export const readDriverComparison = describeOperation({
  summary: 'Autonomous against staged driving, per project, over the last `days`',
  description: SCOPE,
  responses: { 200: json(driverComparisonSchema) },
});

const PROJECT_REFUSALS = {
  403: fail('FORBIDDEN', 'the caller is not a member of the project'),
  404: fail('NOT_FOUND', 'no such project'),
} as const;

export const readCostSummary = describeOperation({
  summary: "A project's cost in the window: total, by step, and its ten costliest issues",
  responses: { 200: json(costSummarySchema), ...PROJECT_REFUSALS },
});

export const readCostTrend = describeOperation({
  summary: "A project's daily cost, with the pipeline-config edits that fall in the window",
  description: 'Narrow to one job type with `step`.',
  responses: { 200: json(costTrendSchema), ...PROJECT_REFUSALS },
});

export const readCostOutliers = describeOperation({
  summary: "A project's costliest runs: those at or above the window's p95 cost, at most 100",
  description: '`threshold` is the p95 itself, 0 when the window holds no outliers.',
  responses: { 200: json(outliersSchema), ...PROJECT_REFUSALS },
});
