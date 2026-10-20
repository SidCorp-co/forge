import { z } from 'zod';
import {
  describeOperation,
  fail,
  json,
  NO_SUCH_PROJECT,
} from '../api-reference/declare/describe.js';
import { pipelineRunKinds, pipelineRunStatuses } from '../db/schema.js';
import { gateConditionSchema } from '../devices/gate-report.js';
import { storedPolicySchema } from '../devices/policy-copy.js';

const nullableIso = z.string().nullable();

const runStepSchema = z.union([
  z.object({ source: z.literal('run_column'), step: z.string(), detail: z.null() }),
  z.object({ source: z.literal('run_journal'), step: z.string(), detail: z.null() }),
  z.object({ source: z.literal('none'), step: z.null(), detail: z.string() }),
]);

const runGroupSchema = z.union([
  z.object({ source: z.literal('run_group'), issues: z.array(z.string()), detail: z.null() }),
  z.object({
    source: z.literal('statuses_at_open'),
    issues: z.array(z.string()),
    detail: z.null(),
  }),
  z.object({ source: z.literal('none'), issues: z.tuple([]), detail: z.string() }),
]);

const costSchema = z.object({
  estimatedCost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  requests: z.number(),
  sampleCount: z.number(),
});

/** One run as a listing shows it: the rollup columns, with no step timeline or attempts. */
export const pipelineRunListItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  issueId: z.string().nullable(),
  lane: z.enum(['job', 'run_session', 'master', 'system']),
  step: runStepSchema,
  group: runGroupSchema,
  runIssues: z.array(z.string()),
  issueRef: z.string().nullable(),
  issueTitle: z.string().nullable(),
  groupTitles: z
    .record(z.string(), z.string())
    .describe("each `group` issue's title by its key; a key no issue of the project has is absent"),
  kind: z.enum(pipelineRunKinds),
  status: z.enum(pipelineRunStatuses),
  currentStep: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: nullableIso,
  cost: costSchema,
  liveJobs: z.number(),
  lastSessionBeatAt: nullableIso,
  reading: z
    .enum(['blocked', 'running', 'starting', 'waiting', 'queued', 'held', 'asking', 'answered'])
    .nullable()
    .describe(
      "what the run's agent is doing: blocked where a box reports a session core still holds blocked, running once a job runs or a session core holds running has checked in, starting where a box has taken or been sent a job it has not started or a session has not checked in since it opened, waiting where only a chat waits on its person's reply, queued where only an untaken job waits, held where only a job core holds waits; with nothing live, asking where its newest job stopped on a question that stands and answered once a person answered it",
    ),
  hold: z
    .object({
      reason: z.string(),
      resumesItself: z.boolean(),
      recheckAt: nullableIso,
      since: nullableIso,
    })
    .nullable()
    .describe(
      "the newest held job's hold: its reason, whether core sends it again by itself, and when it next tries a hold that waits out a clock",
    ),
  block: z
    .object({ blockerKind: z.string().nullable(), parked: z.boolean() })
    .nullable()
    .describe(
      'what a box reports its blocked session on the run waits on, and whether its process has gone',
    ),
  checkInBy: nullableIso.describe(
    'when core ends a session on the run that has not checked in since it opened, if none comes',
  ),
  runningSince: nullableIso.describe(
    'the earliest start of any session on the run, ended ones included: when its work started',
  ),
  sessionId: z.string().nullable().describe("the run's newest session"),
  residentMaster: z
    .object({
      sessionId: z.string(),
      name: z.string().nullable(),
      lastHeartbeatAt: nullableIso,
    })
    .nullable(),
});

const attemptSchema = z.object({
  jobId: z.string(),
  jobType: z.string(),
  status: z.string(),
  attempts: z.number(),
  retryOf: z.string().nullable(),
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  failureReason: z.string().nullable(),
  failureCause: z.string().nullable(),
  failureDetail: z.string().nullable(),
  failureKind: z.enum(['code', 'infra', 'transient-cc', 'timeout']).nullable(),
  failureAction: z.enum(['terminal', 'quarantine', 'failover', 'retry']).nullable(),
  queuedAt: nullableIso,
  startedAt: nullableIso,
  ranAt: nullableIso.describe(
    "when the attempt's own session first reported its agent working; null where it never did",
  ),
  finishedAt: nullableIso,
  autoRetry: z
    .object({
      round: z.number(),
      target: z.string().nullable(),
      tries: z.number(),
      done: z.array(z.string()),
    })
    .nullable(),
  takenBy: z
    .object({ deviceId: z.string(), deviceName: z.string().nullable() })
    .nullable()
    .describe(
      'the box whose session holds this job before starting it; null once started or where none holds it',
    ),
  hold: z
    .object({
      reason: z.string(),
      resumesItself: z.boolean(),
      recheckAt: nullableIso,
      since: nullableIso,
    })
    .nullable()
    .describe(
      'why core holds this job and whether it sends it again by itself; null unless it is held',
    ),
  cancelledBy: z
    .object({
      kind: z.enum(['person', 'agent', 'core']),
      userId: z
        .string()
        .nullable()
        .describe(
          'the account that cancelled it, so a reader can tell its own cancel; null for core',
        ),
      name: z.string().nullable(),
    })
    .nullable()
    .describe('who cancelled this job, or its run; null unless it was cancelled'),
  questionOn: z
    .enum(['issue', 'project'])
    .nullable()
    .describe(
      'where the question this job stopped on stands: on its issue, or the project where it has none or it had closed; null unless it stopped on one',
    ),
});

/** One run with its step timeline, per-attempt device/retry timeline and cost rolled up. */
export const pipelineRunSummarySchema = pipelineRunListItemSchema.extend({
  projectSlug: z
    .string()
    .describe("the slug of the run's own project, whichever org the reader has active"),
  steps: z.array(
    z.object({
      jobType: z.string(),
      status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
      startedAt: nullableIso,
      finishedAt: nullableIso,
      durationMs: z.number().nullable(),
      agentSessionId: z.string().nullable(),
    }),
  ),
  attempts: z.array(attemptSchema),
  retrySummary: z
    .object({
      totalAttempts: z.number(),
      round: z.number(),
      maxRounds: z.number(),
      targetDeviceId: z.string().nullable(),
      targetDeviceName: z.string().nullable(),
    })
    .nullable(),
  gateAtOpen: z
    .union([
      z.object({ read: z.literal('ok'), condition: gateConditionSchema }),
      z.object({ read: z.literal('unreadable'), reason: z.string() }),
    ])
    .nullable(),
  policyAtOpen: z
    .union([
      z.object({ read: z.literal('ok'), policy: storedPolicySchema }),
      z.object({ read: z.literal('unreadable'), reason: z.string() }),
    ])
    .nullable(),
});

export const pipelineRunListSchema = z.object({
  items: z.array(pipelineRunListItemSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export const readPipelineRunSummary = describeOperation({
  summary: 'Read one pipeline run with its steps, attempts and cost',
  responses: {
    200: json(pipelineRunSummarySchema),
    403: fail('FORBIDDEN', "the caller is not a member of the run's project"),
    404: fail('NOT_FOUND', 'no such pipeline run'),
  },
});

export const listProjectPipelineRuns = describeOperation({
  summary: "List a project's pipeline runs, newest first",
  description: 'Filter by `status` or `issueId`; paged with `limit` and `offset`.',
  responses: {
    200: json(pipelineRunListSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: NO_SUCH_PROJECT,
  },
});
