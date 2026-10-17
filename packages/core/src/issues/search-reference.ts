import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import {
  issueDependencyHolds,
  issueDependencyKinds,
  issueStatuses,
  issues,
  waitingKinds,
} from '../db/schema.js';
import { LEASE_VERDICTS } from '../pipeline/session-claim.js';
import { ISSUE_SEARCH_FIELDS } from './search-predicate.js';
import { WORK_STATES } from './work-state.js';

export const issueRowSchema = tableRow(issues);

export const mergeMarkSchema = z.enum(['unmarked', 'asserted', 'landed', 'observed']);

/** The columns both issue lists select: no body, plan, criteria, session context or release notes. */
export const issueListRowSchema = issueRowSchema
  .omit({
    description: true,
    descriptionFormat: true,
    plan: true,
    acceptanceCriteria: true,
    sessionContext: true,
    releaseNotes: true,
    identSearch: true,
    declaredLandingShape: true,
  })
  .extend({
    waitingOnPersonSince: z.date().nullable(),
    statusEnteredAt: z.date(),
    displayId: z.string(),
    mergeMark: mergeMarkSchema,
  });

export const creatorFields = {
  creatorEmail: z.string().nullable().optional(),
  creatorIsAgent: z.boolean().optional(),
  creatorLabel: z.string().optional(),
};

export const workerSchema = z.union([
  z.object({
    lane: z.enum(['job', 'run_session']),
    sessionId: z.string(),
    sessionStatus: z.enum(['queued', 'running']),
  }),
  z.object({
    lane: z.literal('claim'),
    holder: z.string(),
    verdict: z.enum(LEASE_VERDICTS),
    expiresAt: z.string().nullable(),
    silentMs: z.number().nullable(),
  }),
  z.object({ lane: z.literal('none'), detail: z.string() }),
  z.object({ lane: z.literal('unreadable'), detail: z.string() }),
]);

/** Where an issue stands in the pipeline and who, if anyone, is working it. */
export const pipelineHealthSchema = z.object({
  stage: z.enum(issueStatuses),
  worker: workerSchema,
  activeSession: z
    .object({
      id: z.string(),
      status: z.enum(['queued', 'running']),
      skill: z.string(),
      jobType: z.string().nullable(),
    })
    .optional(),
  waitingOn: z
    .object({
      reason: z.enum([
        'issue_busy',
        'job_held',
        'run_not_running',
        'retry_cooldown',
        'runner_stale',
        'runner_too_old',
      ]),
      since: z.string(),
      details: z.record(z.string(), z.unknown()),
    })
    .optional(),
  queuedAt: z.string().optional(),
  queuedStep: z
    .object({
      jobId: z.string(),
      jobType: z.string(),
      stageStatus: z.string().nullable(),
      queuedAt: z.string(),
      retryAfterAt: z.string().nullable(),
    })
    .optional(),
  waitingCause: z.object({ kind: z.enum(waitingKinds) }).optional(),
  pausedRun: z
    .object({
      runId: z.string(),
      pauseReason: z.string().nullable(),
      kind: z.string().nullable(),
      detail: z.string().nullable(),
      resumer: z.enum(['operator', 'machine', 'sweeper']),
      since: z.string(),
    })
    .optional(),
});

const reachCommit = z.object({ sha: z.string(), subject: z.string() });
const reachMeasured = {
  baseBranch: z.string(),
  liveBranch: z.string(),
  measuredAt: z.string(),
  baseSha: z.string(),
  liveSha: z.string(),
};

/** Whether a merged issue's work is on the live branch, as far as one reading can say. */
export const liveReachSchema = z.union([
  z.object({
    ...reachMeasured,
    state: z.literal('not_on_live'),
    evidence: z.array(
      reachCommit.extend({
        via: z.enum(['merged_commit', 'declares_issue', 'merged_in', 'recorded_head']),
      }),
    ),
  }),
  z.object({
    ...reachMeasured,
    state: z.literal('none_waiting'),
    unowned: z.array(reachCommit),
  }),
  z.object({
    state: z.literal('unmeasured'),
    baseBranch: z.string().nullable(),
    liveBranch: z.string(),
    measuredAt: z.string().nullable(),
    reason: z.string(),
  }),
]);

export const issueLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  kind: z.enum(['label', 'module']),
  slug: z.string().nullable(),
  knowledgeEntryId: z.string().nullable(),
  isPrimary: z.boolean(),
});

export const agentSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  title: z.string().nullable(),
  deviceId: z.string().nullable(),
  startedAt: z.date().nullable(),
  lastHeartbeatAt: z.date().nullable(),
  pipelineRunId: z.string().nullable(),
  claudeSessionId: z.string().nullable(),
  deviceName: z.string().nullable(),
});

export const agentStatusSchema = z.enum(['running', 'queued', 'completed', 'failed']).nullable();

/** What `resolveIssueRouteRef` refuses a uuid or a display key with. */
export const ISSUE_REF_REFUSALS = {
  400: fail(
    'BAD_REQUEST',
    'the id is neither a uuid nor a display key, or a display key came without `projectId`',
  ),
  403: fail('FORBIDDEN', "the caller is not a member of the issue's project"),
  404: fail('NOT_FOUND', 'no issue has the id or key'),
} as const;

const edgeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  fromIssueId: z.string(),
  toIssueId: z.string(),
  kind: z.enum(issueDependencyKinds),
  reason: z.string().nullable(),
  createdById: z.string().nullable(),
  createdAt: z.date(),
  validUntil: z.date().nullable(),
  holdsUntil: z.enum(issueDependencyHolds),
  fromTitle: z.string().nullable(),
  fromStatus: z.string().nullable(),
  fromMergedAt: z.date().nullable(),
  toTitle: z.string().nullable(),
  toStatus: z.string().nullable(),
  toMergedAt: z.date().nullable(),
  fromDisplayId: z.string().nullable(),
  toDisplayId: z.string().nullable(),
});

export const dependencyEdgesSchema = z.object({
  outgoing: z.array(edgeSchema),
  incoming: z.array(edgeSchema),
});

/** One row of a search: the list columns, and whichever extras the query asked for with `with...`. */
export const searchItemSchema = issueListRowSchema.extend({
  ...creatorFields,
  matchedFields: z.array(z.enum(ISSUE_SEARCH_FIELDS)).optional(),
  estimatedCost: z.number().optional(),
  failureInfo: z
    .object({
      failedStep: z.string(),
      failureReason: z.string().nullable(),
      failureKind: z.string().nullable(),
      failedAt: z.string(),
    })
    .nullable()
    .optional(),
  pipelineHealth: pipelineHealthSchema.optional(),
  modules: z
    .array(
      z.object({
        labelId: z.string(),
        name: z.string(),
        color: z.string(),
        isPrimary: z.boolean(),
      }),
    )
    .optional(),
  dependencies: dependencyEdgesSchema.optional(),
  agentSessions: z.array(agentSessionSchema).optional(),
  agentStatus: agentStatusSchema.optional(),
  held: z.boolean().optional(),
  lastCheckInAt: z.string().nullable().optional(),
});

export type SearchItem = z.input<typeof searchItemSchema>;

export const issueSearchSchema = z.object({
  items: z.array(searchItemSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
  buckets: z
    .object({
      byStatus: z.record(z.string(), z.number()),
      byWorkState: z.record(z.enum(WORK_STATES), z.number()),
    })
    .optional(),
});

export const searchIssues = describeOperation({
  summary: "Search a project's issues by text or key, with filters, counts and optional extras",
  description:
    'A term that reads as an issue key finds that issue and is never searched as text. `with...` flags add cost, failure, pipeline health, modules, dependencies, agent sessions or the status and work-state counts (`buckets`) to the answer. Archived issues are left out unless `includeArchived` is sent or a key names one. `stuck=true` keeps only the issues a stuck-issue notice stands for.',
  responses: {
    200: json(issueSearchSchema),
    400: fail({
      UNKNOWN_QUERY_PARAMETER:
        'a query parameter this route does not take; details lists the ones it does',
      ISSUE_KEY_FOREIGN_PREFIX: 'the key names another project, which this search does not look in',
      ISSUE_KEY_OUT_OF_RANGE: 'the key reads as a number outside what an issue can have',
    }),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail({
      NOT_FOUND: 'the project does not exist',
      ISSUE_KEY_NOT_HELD: 'the key or issue id names no issue in this project',
    }),
  },
});
