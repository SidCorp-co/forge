import { z } from 'zod';
import { describeOperation, json } from '../api-reference/describe.js';

const workStateCountsSchema = z.object({
  open: z.number(),
  in_flight: z.number(),
  awaiting_release: z.number(),
  blocked_on_person: z.number(),
  draft: z.number(),
  finished: z.number(),
});

const projectHealthSchema = z.object({
  id: z.string(),
  projectName: z.string(),
  projectSlug: z.string(),
  description: z.string().nullable(),
  repoPath: z.string().nullable(),
  throughput: z.number(),
  totalActive: z.number(),
  work: workStateCountsSchema,
  blockers: z.array(z.object({ issueId: z.string(), documentId: z.string(), status: z.string() })),
  blockersTotal: z.number(),
  pendingEscalations: z.number(),
  avgCycleTimeDays: z.number(),
  liveRuns: z.number(),
  runnerCount: z.number(),
  spend24hUsd: z.number(),
  memberCount: z.number(),
  members: z.array(z.string()),
  lastActivityAt: z.string().nullable(),
  loopMonitor: z.object({
    axis: z.literal('job'),
    claimHeldIssues: z.number(),
    sweptBy: z.literal('pipeline/idle-issues.ts'),
  }),
});

export const projectHealthListSchema = z.array(projectHealthSchema);

export const readProjectHealth = describeOperation({
  summary: 'A health rollup of every project the caller can see, one row per project',
  description:
    '`work` counts issues by work state; `blockers` is the capped list of parked issues and `blockersTotal` the count behind it; `members` holds up to five avatar initials. Join a row to `GET /api/projects` by `id`.',
  responses: { 200: json(projectHealthListSchema, 'One health row per visible project') },
});
