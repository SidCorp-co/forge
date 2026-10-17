import { z } from 'zod';
import { tableRow } from '../api-reference/declare/rows.js';
import { issueStatuses, pipelineRunStatuses, releaseCrossings } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';

const detailsSchema = z.record(z.string(), z.unknown());
const verificationSchema = z.enum(['probed', 'unverified']);
const verifySourceSchema = z.enum(['binding', 'environments-live', 'declared-unusable', 'none']);
const issueStatusSchema = z.enum(issueStatuses);

const blockerSchema = z.object({
  code: z.string(),
  httpStatus: z.union([z.literal(409), z.literal(503)]),
  message: z.string(),
  details: detailsSchema.optional(),
  evaluated: z.boolean(),
  scope: z.literal('roster').optional(),
});

const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: detailsSchema.optional(),
});

const landedIssueSchema = z.object({
  issueId: z.string(),
  displayId: z.string(),
  title: z.string(),
  status: z.string(),
  landing: z.string(),
});

const carriedIssueSchema = landedIssueSchema.extend({
  decision: z.enum(['ship-unverified', 'revert', 'cut-below']).nullable(),
  why: z.string().optional(),
});

/** What a release's range carries beyond its roster, or why the range was not read. */
const carriedRecordSchema = z
  .union([
    z.object({ kind: z.enum(['not-read', 'unbound', 'unread']), why: z.string() }),
    z.object({
      kind: z.literal('read'),
      live: z.string(),
      start: z.string(),
      cut: z.string(),
      issues: z.array(carriedIssueSchema),
      cutBelow: z.array(carriedIssueSchema),
    }),
  ])
  .nullable();

const closeRefusalSchema = z.object({
  code: z.enum(['CLOSE_REQUIRES_SHIPPED', 'OPEN_QUESTIONS', 'ENTRY_CRITERIA_UNMET']),
  reason: z.string(),
  clears: z.string(),
  /** The shortfall and what clears it, as whole sentences a page shows as they are. */
  said: z.string(),
});

export const rosterSchema = z.object({
  gateStatus: issueStatusSchema.nullable(),
  channels: z.array(z.string()),
  releaseRunnerLabel: z.string().nullable(),
  baseBranch: z.string().nullable(),
  nextCutAt: z.string().nullable(),
  currentVersion: z.string().nullable(),
  issues: z.array(
    z.object({
      id: z.string(),
      displayId: z.string(),
      title: z.string(),
      mergedAt: z.string().nullable(),
      waitingDays: z.number().nullable(),
      claimedByRunId: z.string().nullable(),
      closeRefusals: z.array(closeRefusalSchema),
      closeFailure: z.object({ reason: z.string(), version: z.string().nullable() }).nullable(),
    }),
  ),
});

export const createdSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  issueIds: z.array(z.string()),
  gateStatus: issueStatusSchema,
  version: z.string(),
  ownerDeadlineAt: z.string(),
  openedAfterRelease: z.boolean(),
  verification: verificationSchema,
  carried: carriedRecordSchema,
  warnings: z.array(warningSchema),
});

export const activeSchema = z
  .object({
    runId: z.string(),
    issueIds: z.array(z.string()),
    startedAt: z.string(),
    version: z.string().nullable(),
  })
  .nullable();

export const readinessSchema = z.object({
  hasReleaseGate: z.boolean(),
  releaseChain: z.array(
    z.object({ branch: z.string(), from: z.enum(releaseCrossings).optional() }),
  ),
  releaseModel: z.enum(['none', 'promote', 'publish']),
  releaseStrategy: z.enum(releaseCrossings).nullable(),
  baseBranch: z.string(),
  liveBranch: z.string().nullable(),
  targetUndeclared: z.boolean(),
  providers: z.array(z.string()),
  releaseRunnerLabel: z.string().nullable(),
  rollback: z.string().nullable(),
  rollbackMode: z.enum(['manual', 'coolify-image', 'unrepresentable']).nullable(),
  hasVerify: z.boolean(),
  verifySources: z.array(verifySourceSchema),
  declarationRead: z.boolean(),
  channelsRead: z.boolean(),
  gaps: z.array(z.string()),
  /** `reader` is the sentence a person reads; `message` stays the caller's. */
  blockers: z.array(blockerSchema.extend({ reader: z.string() })),
  warnings: z.array(warningSchema.extend({ reader: z.string() })),
  carried: carriedRecordSchema,
});

export const servingSchema = z.object({
  verified: z.boolean(),
  identity: z.string().nullable(),
  health: z.enum(['up', 'down', 'unknown']),
  readings: z.array(z.string()),
  unhealthy: z.array(z.string()),
  unidentified: z.array(z.string()),
  disagreement: z.array(z.string()).nullable(),
  readAt: z.string(),
  verifySource: verifySourceSchema,
});

export const batchContextSchema = z
  .object({
    runId: z.string(),
    projectId: z.string(),
    gateStatus: issueStatusSchema,
    version: z.string().nullable(),
    baseBranch: z.string().nullable(),
    liveBranch: z.string().nullable(),
    deployPlanned: z.boolean(),
    promotePlanned: z.boolean(),
    releaseRunner: z
      .object({
        label: z.string().nullable(),
        preferenceMet: z.boolean(),
        claimedByDeviceId: z.string().nullable(),
      })
      .nullable(),
    issues: z.array(
      z.object({
        id: z.string(),
        displayId: z.string(),
        title: z.string(),
        releaseNotes: z.unknown(),
        status: issueStatusSchema,
      }),
    ),
  })
  .nullable();

const actorSchema = z.union([
  z.object({
    type: z.literal('user'),
    id: z.string(),
    agency: z.enum(['human', 'agent']).optional(),
  }),
  z.object({ type: z.literal('device'), id: z.string(), ownerId: z.string() }),
]);

const finishRecordSchema = z.object({
  requestId: z.string(),
  state: z.enum(['accepted', 'verifying', 'closing', 'finished', 'failed']),
  commit: z.string().nullable(),
  requestedBy: actorSchema,
  acceptedAt: z.string(),
  updatedAt: z.string(),
  version: z.number(),
  owner: z.string().nullable(),
  leaseUntil: z.string().nullable(),
  workerStarts: z.number(),
  closed: z.array(z.string()).nullable(),
  failed: z.array(z.object({ id: z.string(), reason: z.string() })).nullable(),
  refusal: z
    .object({ code: z.string(), reason: z.string(), live: z.string().nullable() })
    .nullable(),
  verification: verificationSchema.nullable(),
  evidence: z.array(z.string()).nullable(),
  finishedAt: z.string().nullable(),
});

/** What a finish call answers: `started` is false where it answered an attempt already standing. */
export const finishAcceptedSchema = z.object({ runId: z.string(), finish: finishRecordSchema });

const liveStateSchema = z.object({
  health: z.enum(['up', 'down']),
  identity: z.string().nullable(),
  answeredBy: z.array(z.object({ url: z.string(), commit: z.string() })),
  readings: z.array(z.string()),
  unhealthy: z.array(z.string()),
  unidentified: z.array(z.string()),
  disagreement: z.array(z.string()).nullable(),
});

const readingViewSchema = z.object({
  id: z.string(),
  takenAt: z.string(),
  takenBy: z.string(),
  bindings: z.array(liveStateSchema.extend({ bindingId: z.string(), name: z.string() })),
  unread: z.array(z.string()),
});

export const lookSchema = z.object({
  reading: readingViewSchema,
  judgement: z.union([
    z.object({ closable: z.literal(true), moved: z.boolean(), evidence: z.array(z.string()) }),
    z.object({ closable: z.literal(false), reason: z.string(), live: z.string().nullable() }),
  ]),
});

export const abortedSchema = z.object({
  aborted: z.literal(true),
  releasedIds: z.array(z.string()),
  claimsCleared: z.array(z.string()),
  alreadyClosed: z.array(z.string()),
  recovered: z.array(z.string()),
  destination: issueStatusSchema.nullable(),
  promoted: z.boolean(),
  run: z.object({
    status: z.enum(pipelineRunStatuses).nullable(),
    wasAlreadyTerminal: z.boolean(),
    cancelledFrom: z.enum(pipelineRunStatuses).nullable(),
  }),
});

export const attemptRowSchema = tableRow(releaseAttempts);

export const methodSchema = z.object({
  skill: z.string(),
  loaded: z.boolean(),
  detail: z.string().nullable(),
  announcedAt: z.string(),
});

const boundNameSchema = z.enum(['total', 'stall', 'regression']);

export const stateSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  runStatus: z.string(),
  version: z.string().nullable(),
  roster: rosterSchema,
  runIssues: z.array(
    z.object({ id: z.string(), displayId: z.string(), title: z.string(), status: z.string() }),
  ),
  attempts: z.array(attemptRowSchema),
  live: liveStateSchema.nullable(),
  readings: z.object({ total: z.number(), latest: z.array(readingViewSchema) }),
  verification: verificationSchema.nullable(),
  bounds: z.object({
    holding: z.boolean(),
    crossedNames: z.array(boundNameSchema),
    bounds: z.array(
      z.object({
        name: boundNameSchema,
        crossed: z.boolean(),
        measuredMs: z.number().nullable(),
        thresholdMs: z.number().nullable(),
        why: z.string(),
      }),
    ),
  }),
  method: methodSchema.nullable(),
  methodUnloaded: z.boolean(),
  finish: finishRecordSchema.nullable(),
  start: z.union([
    z.object({ kind: z.literal('taken'), at: z.string(), device: z.string().nullable() }),
    z.object({
      kind: z.literal('waiting'),
      since: z.string(),
      handedBackAt: z.string(),
      reason: z.enum(['no-eligible-box', 'no-box', 'eligible-not-taken']),
      why: z.string(),
    }),
    z.object({ kind: z.literal('claimed'), since: z.string(), why: z.string() }),
    z.object({ kind: z.literal('handed-back'), at: z.string(), why: z.string() }),
    z.object({ kind: z.literal('aborted'), at: z.string(), by: z.string(), why: z.string() }),
    z.object({
      kind: z.literal('ended'),
      status: z.string(),
      at: z.string().nullable(),
      why: z.string(),
    }),
    z.object({ kind: z.literal('none'), why: z.string() }),
  ]),
  decision: z
    .object({
      phase: z.enum(['waiting', 'answered', 'withdrawn']),
      since: z.string(),
      issue: z.object({ id: z.string(), displayId: z.string() }).nullable(),
      questions: z.array(
        z.object({
          id: z.string(),
          prompt: z.string(),
          options: z.array(z.object({ id: z.string(), label: z.string() })),
          recommendedOptionId: z.string().nullable(),
          status: z.string(),
          answer: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
});

const recordedIssueSchema = z.object({
  id: z.string(),
  mergedAt: z.string().nullable(),
  mergedCommitSha: z.string().nullable(),
});

export const recordedSchema = z.object({
  runId: z.string(),
  commit: z.string(),
  identity: z.string().nullable(),
  readings: z.array(z.string()),
  verification: verificationSchema,
  unread: z.array(z.string()),
  closed: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), reason: z.string() })),
  issues: z.array(recordedIssueSchema),
});

export const recordViewSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  recordedAt: z.string().nullable(),
  commit: z.string().nullable(),
  identity: z.string().nullable(),
  providerRef: z.string().nullable(),
  account: z.string().nullable(),
  readings: z.array(z.string()),
  verification: verificationSchema,
  issues: z.array(recordedIssueSchema),
});
