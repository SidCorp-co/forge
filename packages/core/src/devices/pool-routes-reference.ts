import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { issueDependencyHolds } from '../db/issue-vocabulary.js';
import {
  answerShapes,
  optionAuthorities,
  optionBindings,
  optionExecutors,
  questionBlockerKinds,
} from '../db/question-vocabulary.js';
import { runnerLimitReasons } from '../db/schema.js';
import { pullRequestStates } from '../db/schema-repo-projection.js';
import { utf16String } from '../lib/utf16-string.js';
import { deviceGateSchema } from './routes-reference.js';

export const poolQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  projectId: z.string().uuid().optional(),
});

export const leaseParamsSchema = z.object({ issueKey: z.string().min(1).max(64) });
export const leaseQuerySchema = z.object({ projectId: z.string().uuid().optional() });

export const claimBodySchema = z.object({
  jobId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

export const releaseBodySchema = z.object({
  jobId: z.string().uuid().optional(),
  sessionId: z.string().uuid(),
});

export const loadQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
});

export const masterSessionBodySchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(120),
});

export const masterCloseBodySchema = z.object({
  sessionId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});

export const masterLimitSchema = z.object({
  reason: z.enum(runnerLimitReasons),
  resetsInSeconds: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60)
    .nullish(),
  detail: utf16String(200).min(1),
});

const questionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  authority: z.enum(optionAuthorities),
  bindsTo: z.enum(optionBindings),
  executedBy: z.enum(optionExecutors),
  fingerprint: z.string().optional(),
});

/**
 * What a box asks. `id`, `projectId` and `prompt` are required; the rest rides along as the box
 * sent it, which is why other keys are let through. A box sends `null` for what it has none of.
 */
export const askQuestionBodySchema = z.looseObject({
  // Each id below is compared with a uuid column, so a malformed one is refused by name (ISS-1421 r18).
  id: z.uuid(),
  projectId: z.uuid(),
  prompt: z.string().min(1),
  runId: z
    .string()
    .nullish()
    .describe('When present, the box is registered to read the answer back'),
  issueId: z.uuid().optional(),
  agentSessionId: z.uuid().optional(),
  blockerKind: z.enum(questionBlockerKinds).nullish().describe('`human` when absent'),
  answerShape: z.enum(answerShapes).nullish().describe('`choice` when absent'),
  options: z.array(questionOptionSchema).nullish(),
  recommendedOptionId: z.string().nullish(),
  needed: z.string().nullish().describe('What would settle a `free_text` question'),
  assumed: z.record(z.string(), z.unknown()).optional(),
  cost: z
    .object({
      claimsHeld: z.number().optional(),
      workspacesPinned: z.number().optional(),
      dependents: z.number().optional(),
    })
    .optional(),
  sensitive: z.boolean().optional(),
});

export const questionParamSchema = z.object({ questionId: z.uuid() });
export const questionQuerySchema = z.object({
  runId: z
    .string()
    .default('')
    .describe('The run the question was asked under; the answer is read back only for it'),
});

const poolRelationSchema = z.object({
  kind: z.string(),
  dependsOnKey: z.string().nullable(),
  blockerStatus: z.string().nullable(),
  blockerMergedAt: z.string().nullable(),
  edgeValidUntil: z.string().nullable(),
  holdsUntil: z.enum(issueDependencyHolds),
});

const poolEntrySchema = z.object({
  jobId: z.string(),
  type: z.string(),
  issueId: z.string().nullable(),
  issueKey: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  priority: z.string().nullable(),
  category: z.string().nullable(),
  status: z.string().nullable(),
  ageMinutes: z.number(),
  attempts: z.number(),
  relations: z.array(poolRelationSchema),
  heldBy: z.string().nullable(),
});

const pullRequestSchema = z.object({
  number: z.number(),
  repo: z.string(),
  url: z.string().nullable(),
  title: z.string(),
  state: z.enum(pullRequestStates),
  draft: z.boolean(),
  headRef: z.string(),
  headSha: z.string(),
  baseRef: z.string(),
  behindBy: z.number().nullable(),
  aheadBy: z.number().nullable(),
  mergeableState: z.string().nullable(),
  refreshedForHead: z.string().nullable(),
  refreshError: z.string().nullable(),
  checks: z.object({
    total: z.number(),
    success: z.number(),
    failure: z.number(),
    pending: z.number(),
  }),
  reviews: z.array(
    z.object({
      id: z.string(),
      reviewer: z.string(),
      state: z.string(),
      submittedAt: z.string().nullable(),
    }),
  ),
  mergedAt: z.string().nullable(),
  mergeCommitSha: z.string().nullable(),
});

const admissibleIssueSchema = z.object({
  issueId: z.string(),
  issueKey: z.string().nullable(),
  projectId: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  priority: z.string().nullable(),
  category: z.string().nullable(),
  status: z.string(),
  ageMinutes: z.number(),
  relations: z.array(poolRelationSchema),
  mergedAt: z.string().nullable(),
  branch: z.string().nullable(),
  pullRequests: z.array(pullRequestSchema),
});

export const poolSchema = z.object({ items: z.array(poolEntrySchema), count: z.number() });
export const admissibleSchema = z.object({
  items: z.array(admissibleIssueSchema),
  count: z.number(),
});

export const runSessionTerminalSchema = z.object({ sessionTerminal: z.boolean() });

const leaseHolderSchema = z.object({
  issueKey: z.string(),
  deviceId: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  acquiredAt: z.string(),
});

export const issueLeaseSchema = z.object({
  held: z.boolean(),
  heldByThisDevice: z.boolean(),
  holder: leaseHolderSchema.nullable(),
  issueOver: z.boolean().nullable(),
});

export const leaseGivenBackSchema = z.object({
  ok: z.literal(true),
  issueKey: z.string(),
  projectId: z.string(),
});

const preparedJobSchema = z.object({
  jobId: z.string(),
  projectId: z.string(),
  issueId: z.string().nullable(),
  type: z.string(),
  agentSessionId: z.string(),
  systemPrompt: z.string(),
  promptString: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  model: z.string(),
  repoPath: z.string().nullable(),
  priorClaudeSessionId: z.string().nullable(),
  runnerId: z.string(),
  runnerType: z.string(),
  attempts: z.number(),
  sessionResidencySeconds: z.number().optional(),
});

export const prepareResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    jobId: z.string(),
    issueKey: z.string().nullable(),
    prepared: preparedJobSchema,
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'not_found',
      'already_held',
      'issue_busy',
      'budget_exhausted',
      'hold_lost',
      'runner_too_old',
      'runner_withdrawn',
      'device_disabled',
      'runner_unbound',
      'release_label_missing',
      'no_prompt',
    ]),
  }),
]);

export const startResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.enum(['hold_lost', 'runner_too_old']) }),
]);

export const releasedSchema = z.object({ released: z.number() });

const runnerFaultsSchema = z.array(
  z.object({ runnerId: z.string(), limitReason: z.string(), until: z.string().nullable() }),
);

export const loadSchema = z.object({
  device: z
    .object({
      deviceId: z.string(),
      name: z.string(),
      jobsRunning: z.number(),
      reposLocked: z.array(z.string()),
      agentVersion: z.string().nullable(),
      lastSeenMinutes: z.number().nullable(),
      runnerFaults: runnerFaultsSchema,
      gate: deviceGateSchema.nullable(),
    })
    .nullable(),
  project: z
    .object({
      projectId: z.string(),
      slug: z.string(),
      jobsRunning: z.number(),
      poolDepth: z.number(),
      byType: z.record(z.string(), z.number()),
      oldestRunningMinutes: z.number().nullable(),
    })
    .nullable(),
  fleet: z.array(
    z.object({
      deviceId: z.string(),
      name: z.string(),
      online: z.boolean(),
      jobsRunning: z.number(),
      agentVersion: z.string().nullable(),
      lastSeenMinutes: z.number().nullable(),
      runnerFaults: runnerFaultsSchema,
      gate: deviceGateSchema.nullable(),
    }),
  ),
});

export const masterSessionSchema = z.object({
  sessionId: z.string(),
  name: z.string(),
  created: z.boolean(),
});

export const masterClosedSchema = z.object({ closed: z.boolean() });
export const protectionsSchema = z.object({ protections: z.array(z.string()) });
export const questionAskedSchema = z.object({ questionId: z.string() });

export const questionAnswerSchema = z.object({
  answer: z
    .object({
      questionId: z.string(),
      answerShape: z.enum(answerShapes),
      optionId: z.string().nullable(),
      text: z.string().nullable(),
      answeredAt: z.string(),
      answeredBy: z.string().optional(),
      round: z.number(),
    })
    .nullable(),
});

export const limitStampedSchema = z.object({ runnerId: z.string() });

/** What the question write refuses on an ask. */
const refusedAtWrite = {
  QUESTION_REFUSED:
    'an option binds to one call and carries no fingerprint, or nothing was written',
  QUESTION_OPTIONS_REQUIRED: 'a choice round has no options',
  QUESTION_OPTION_IDS_DUPLICATE: 'two options share an id',
  QUESTION_RECOMMENDED_UNKNOWN: '`recommendedOptionId` is not one of the options',
  QUESTION_SHAPE_INVALID: 'a free-text round states nothing in `needed`',
  QUESTION_MESSAGE_REFUSED: "the round's text was refused when screened",
  QUESTION_ISSUE_ELSEWHERE: 'the issue does not exist or belongs to another project',
  QUESTION_ISSUE_TERMINAL: 'the issue is closed or dropped, so no answer could reach it',
};

const noRunner = fail('NOT_FOUND', 'the device has no claude-code runner');
const notBound = fail('FORBIDDEN', 'the device is not bound to the project');

const leaseKeyRefusals = {
  400: fail({
    ISSUE_LEASE_KEY_SHAPE: 'the key is not an issue reference',
    ISSUE_LEASE_KEY_PROJECT_MISMATCH:
      "the key's prefix belongs to another project than `projectId`",
  }),
  404: fail({
    ISSUE_LEASE_KEY_UNKNOWN_PREFIX: 'no project holds the key prefix',
  }),
} as const;

export const readPoolRoute = describeOperation({
  summary:
    'Read the queued jobs this device may take, oldest first, with the facts to order them by',
  responses: { 200: json(poolSchema) },
});

export const readAdmissible = describeOperation({
  summary: 'Read the issues a master may open a run session over, with their pull requests',
  description: 'Only projects that declared an admissible set contribute rows.',
  responses: { 200: json(admissibleSchema) },
});

export const readRunSessionTerminalRoute = describeOperation({
  summary: "Say whether one of this device's run sessions has ended",
  responses: {
    200: json(runSessionTerminalSchema),
    404: fail('NOT_FOUND', 'no run session of this device has that id'),
  },
});

export const readIssueLease = describeOperation({
  summary: 'Read who holds the lease on an issue, as this box sees it',
  description: 'The key may carry the project prefix or be canonical `ISS-n`.',
  responses: { 200: json(issueLeaseSchema), ...leaseKeyRefusals },
});

export const giveIssueLeaseBack = describeOperation({
  summary: "Give back this box's lease on an issue",
  description: 'A delete that matched nothing is an error, never an acknowledgement.',
  responses: {
    200: json(leaseGivenBackSchema, 'The lease was released'),
    400: leaseKeyRefusals[400],
    404: fail({
      ISSUE_LEASE_KEY_UNKNOWN_PREFIX: 'no project holds the key prefix',
      ISSUE_LEASE_NOT_HELD: 'this box holds no such lease',
    }),
    409: fail(
      'ISSUE_LEASE_AMBIGUOUS',
      'this box holds the key in more than one project; name one with `projectId`',
    ),
  },
});

export const prepareJob = describeOperation({
  summary: 'Take a queued job for a master session and build its work, without starting it',
  description:
    'A refusal is a 200 with `ok: false` and a `reason`. The caller then owes `pool/start` or `pool/release`.',
  responses: { 200: json(prepareResultSchema) },
});

export const startJob = describeOperation({
  summary: 'Hand a prepared job to the process now starting it',
  responses: { 200: json(startResultSchema) },
});

export const releaseJob = describeOperation({
  summary: 'Give a held job back to the pool, or every job a session holds when no job is named',
  responses: { 200: json(releasedSchema) },
});

export const readLoad = describeOperation({
  summary: 'Read how loaded this device, the project and the fleet bound to it are',
  responses: { 200: json(loadSchema) },
});

export const registerMasterSession = describeOperation({
  summary: "Register this box's resident master for a project, or find the one already live",
  responses: { 200: json(masterSessionSchema) },
});

export const closeMasterSessionRoute = describeOperation({
  summary: 'Report a master the box watched die',
  description: "`closed` is false when the session was already over or is not this device's.",
  responses: { 200: json(masterClosedSchema) },
});

export const listProtections = describeOperation({
  summary: 'List the park protections this core knows, so a box can tell if it is behind',
  responses: { 200: json(protectionsSchema) },
});

export const askQuestionRoute = describeOperation({
  summary: 'Ask a question on behalf of a run and get its id',
  responses: {
    200: json(questionAskedSchema),
    400: fail({
      BAD_REQUEST:
        'the body is not JSON, `id`, `projectId` or `prompt` is missing, or a field has the wrong type',
      ...refusedAtWrite,
    }),
    403: notBound,
  },
});

export const readQuestionAnswer = describeOperation({
  summary: 'Read the answer to a question this run asked; `answer` is null until someone answers',
  responses: {
    200: json(questionAnswerSchema),
    404: fail('NOT_FOUND', 'this device and run never waited on the question'),
  },
});

export const reportMasterLimit = describeOperation({
  summary: "Report that the master's account hit a limit, so dispatch stops sending it work",
  responses: {
    200: json(limitStampedSchema),
    400: fail('AUTH_LIMIT_HAS_NO_RESET', 'an `auth` limit was reported with `resetsInSeconds`'),
    404: noRunner,
  },
});

export const clearMasterLimitRoute = describeOperation({
  summary: "Lift the limit on this device's runners after the master's next successful turn",
  responses: { 200: json(limitStampedSchema), 404: noRunner },
});
