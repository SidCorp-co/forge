import { z } from 'zod';
import { describeOperation, json } from '../api-reference/declare/describe.js';
import { FAILURE_CAUSES } from '../pipeline/failure-causes.js';

/** A set counted whole and named only as far as `thresholds.identityCap`. */
function capped<T extends z.ZodType>(item: T) {
  return z.object({ total: z.number().int(), shown: z.array(item) });
}

const issueIdentity = z.object({
  documentId: z.string(),
  issueRef: z.string(),
  title: z.string(),
  status: z.string(),
  projectSlug: z.string(),
  ageSeconds: z.number(),
});

const projectIdentity = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  backlog: z.number().int(),
  lastIssueRunAt: z.string().nullable(),
});

const lane = z.object({ failed: z.number().int(), total: z.number().int() });

const openWorkBuckets = {
  open: z.number().int(),
  in_flight: z.number().int(),
  awaiting_release: z.number().int(),
  blocked_on_person: z.number().int(),
};

export const pulseQuerySchema = z.object({
  orgId: z.uuid().optional().describe('Only the projects of this organization'),
});

export const pulseSchema = z.object({
  generatedAt: z.string(),
  thresholds: z
    .object({
      abandonedIssueSeconds: z.number(),
      releaseWaitingSeconds: z.number(),
      projectSilenceSeconds: z.number(),
      silenceWarnSeconds: z.number(),
      silenceAlarmSeconds: z.number(),
      identityCap: z.number().int(),
    })
    .describe('Every cutoff the figures are marked against'),
  liveness: z.object({
    jobsRunning: z.number().int(),
    jobsQueued: z.number().int(),
    jobsHeld: z.number().int(),
    liveJobs: capped(
      z.object({
        jobId: z.string(),
        runId: z.string(),
        type: z.string(),
        projectSlug: z.string(),
        issueRef: z.string().nullable(),
        issueDocId: z.string().nullable(),
        ageSeconds: z.number(),
      }),
    ),
    stuckRuns: capped(
      z.object({
        runId: z.string(),
        projectSlug: z.string(),
        issueRef: z.string().nullable(),
        issueDocId: z.string().nullable(),
        ageSeconds: z.number(),
      }),
    ),
    lastJobAt: z.string().nullable(),
    silenceSeconds: z.number().nullable(),
    heartbeat: z.array(z.object({ date: z.string(), issueRuns: z.number().int() })),
    devices: z.object({
      online: z.number().int(),
      draining: z.number().int(),
      total: z.number().int(),
    }),
  }),
  work: z.object({
    buckets: z.object(openWorkBuckets),
    abandoned: capped(issueIdentity),
    releaseWaiting: capped(issueIdentity),
    notOnLive: capped(
      issueIdentity.extend({
        liveBranch: z.string(),
        evidence: z.array(
          z.object({
            sha: z.string(),
            subject: z.string(),
            via: z.enum(['merged_commit', 'declares_issue', 'merged_in', 'recorded_head']),
          }),
        ),
      }),
    ),
    liveUnmeasured: capped(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        baseBranch: z.string().nullable(),
        liveBranch: z.string(),
        reason: z.string(),
      }),
    ),
    silentProjects: capped(projectIdentity),
    neverRanProjects: capped(projectIdentity),
    blockedOnPersonAges: z.array(z.number()).describe('Seconds each waited, oldest first'),
    perProject: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        ...openWorkBuckets,
        stuckRuns: z.number().int(),
        abandonedIssues: z.number().int(),
        lastIssueRunAt: z.string().nullable(),
      }),
    ),
  }),
  flow: z.array(
    z.object({
      weekStart: z.string(),
      created: z.number().int(),
      closed: z.number().int(),
      reopened: z.number().int(),
      backlog: z.number().int(),
    }),
  ),
  quality: z.object({
    finished: z.object({
      merged: z.number().int(),
      closedUnmerged: z.number().int(),
      dropped: z.number().int(),
    }),
    reopened: z.object({ issues: z.number().int(), events: z.number().int() }),
    rework: z.object({ fix: z.number().int(), code: z.number().int() }),
    runFailure: z.object({ pipeline: lane, scheduler: lane, other: lane }),
    sessionFailures: z.array(z.object({ reason: z.enum(FAILURE_CAUSES), count: z.number().int() })),
    pipelineFlow: z.array(
      z.object({
        type: z.string(),
        count: z.number().int(),
        medianSeconds: z.number().nullable(),
      }),
    ),
  }),
});

export const readPulse = describeOperation({
  summary: 'Read the workspace dashboard: liveness, where work is piling up, flow and quality',
  description:
    'Covers every project the caller can see, or those of one organization with `orgId`. A caller who can see none gets the same document with every count at zero.',
  responses: { 200: json(pulseSchema) },
});
