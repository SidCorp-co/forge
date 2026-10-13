import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

const NOT_FOUND = fail('NOT_FOUND', 'the project does not exist');
const NOT_A_MEMBER = fail('FORBIDDEN', 'the caller is not a member of the project');
const refused = { 403: NOT_A_MEMBER, 404: NOT_FOUND } as const;

export const timeseriesSchema = z.object({
  metric: z.string(),
  bucket: z.enum(['day', 'hour']),
  days: z.number(),
  groupBy: z.literal('step').nullable(),
  series: z.array(z.object({ ts: z.string() }).catchall(z.unknown())),
});

const durationNumber = z.union([z.number(), z.string()]).nullable();

export const stepDurationsSchema = z.object({
  rows: z.array(
    z.object({
      step: z.string(),
      p50_s: durationNumber,
      p95_s: durationNumber,
      avg_s: durationNumber,
      total_cost: durationNumber,
      n: durationNumber,
      breakdown_key: z.string().nullable().optional(),
    }),
  ),
  windowDays: z.number(),
});

export const retryRescuesSchema = z.object({
  rows: z.array(
    z.object({
      failureKind: z.string().nullable(),
      failureReason: z.string(),
      rescues: z.number(),
      lastRescuedAt: z.string(),
    }),
  ),
  total: z.number(),
  windowDays: z.number(),
  projectId: z.string(),
});

export const sessionFailuresSchema = z.object({
  rows: z.array(
    z.object({
      cause: z.string(),
      origin: z.string(),
      sessions: z.number(),
      isRealFailure: z.boolean(),
      lastAt: z.string().nullable(),
    }),
  ),
  total: z.number(),
  unclassified: z.number(),
  unclassifiedRate: z.number(),
  nonFailedWithFailureReason: z.number(),
  resumeContinuity: z.object({
    offered: z.number(),
    resumed: z.number(),
    dropped: z.number(),
    dropRate: z.number(),
    rows: z.array(z.object({ reason: z.string(), sessions: z.number() })),
  }),
  windowDays: z.number(),
  projectId: z.string(),
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

export const readTimeseries = describeOperation({
  summary: 'One metric of the project as a gap-filled series, for a trend chart',
  description:
    'Every bucket of the window is present, empty ones filled with defaults. The fields of a point beyond `ts` depend on the metric: `costUsd`, `resolved`, `avgDays`, `medianMs`, `busyPct`, `rate` and so on. `groupBy=step` splits the `cost` series by pipeline step and is ignored for every other metric.',
  responses: { 200: json(timeseriesSchema, 'The series, one point per bucket'), ...refused },
});

export const readStepDurations = describeOperation({
  summary: "How long each pipeline step takes in the project, with the step's cost",
  description:
    'Percentiles are in seconds. `breakdown` splits each step by device or by model and adds `breakdown_key` to a row.',
  responses: {
    200: json(stepDurationsSchema, 'One row per step, or per step and breakdown'),
    ...refused,
  },
});

export const readRetryRescues = describeOperation({
  summary: 'The runs a retry rescued, grouped by the failure that was retried',
  responses: {
    200: json(retryRescuesSchema, 'Rescues in the window, with their total'),
    ...refused,
  },
});

export const readSessionFailures = describeOperation({
  summary: 'The failed agent sessions of the window, grouped by cause',
  description: 'Also reports how many attempts that had a transcript to continue did continue it.',
  responses: {
    200: json(sessionFailuresSchema, 'Failures by cause, and the resume continuity'),
    ...refused,
  },
});

export const readInterventions = describeOperation({
  summary: 'The times a person or a script had to step in on the project',
  responses: {
    200: json(interventionsSchema, 'The interventions, per issue and as the 2000 newest events'),
    ...refused,
  },
});
