import { z } from 'zod';
import { describeOperation, json } from '../api-reference/declare/describe.js';
import { STUCK_ISSUE_KINDS } from './stuck-issue-kinds.js';

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
  blockers: z.array(
    z.object({
      issueId: z.string(),
      documentId: z.string(),
      title: z.string(),
      status: z.string(),
    }),
  ),
  blockersTotal: z.number(),
  pendingEscalations: z.number(),
  avgCycleTimeDays: z.number(),
  liveRuns: z.number(),
  liveSessions: z.number(),
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
  stuckIssues: z.number(),
  stuckIssuesByKind: z.partialRecord(z.enum(STUCK_ISSUE_KINDS), z.number()),
  stuckIssueRefs: z.array(
    z.object({
      issueId: z.string(),
      documentId: z.string(),
      title: z.string(),
      kind: z.enum(STUCK_ISSUE_KINDS),
    }),
  ),
});

export const projectHealthListSchema = z.array(projectHealthSchema);

export const readProjectHealth = describeOperation({
  summary: 'A health rollup of every project the caller can see, one row per project',
  description:
    '`work` counts issues by work state; `blockers` is the capped list of parked issues and `blockersTotal` the count behind it; `members` holds up to five avatar initials; `stuckIssues` counts the issues a stuck-issue notice stands for, `stuckIssuesByKind` counts each once by its most specific reason (`waiting` on a person over six hours, then `owed_close`, `orphan`, `idle`), so the kinds add up to `stuckIssues`, and `stuckIssueRefs` names up to five with the kind of each, longest-standing first. Join a row to `GET /api/projects` by `id`.',
  responses: { 200: json(projectHealthListSchema, 'One health row per visible project') },
});
