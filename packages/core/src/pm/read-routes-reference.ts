import { z } from 'zod';
import { describeOperation, fail, json, NO_SUCH_PROJECT } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { issueDependencyKinds, issues, jobs, runners } from '../db/schema.js';

const VIEWER = fail('FORBIDDEN', 'the caller is not a member of the project');

const runnerSchema = tableRow(runners).pick({
  id: true,
  type: true,
  status: true,
  lastSeenAt: true,
});

export const runnerLoadSchema = z.array(runnerSchema.extend({ inFlight: z.number() }));

export const snapshotSchema = z.object({
  countsByStatus: z.record(z.string(), z.number()),
  activeJobs: z.array(
    tableRow(jobs).pick({ id: true, type: true, status: true, issueId: true, queuedAt: true }),
  ),
  stalledIssues: z.array(
    tableRow(issues)
      .pick({ id: true, status: true, updatedAt: true })
      .extend({ issueId: z.string() }),
  ),
  queuedCount: z.number(),
  recentFailures: z.array(
    tableRow(jobs).pick({
      id: true,
      type: true,
      failureKind: true,
      failureReason: true,
      finishedAt: true,
    }),
  ),
  runnerHealth: z.array(runnerSchema.extend({ inFlight: z.number() })),
});

export const graphSchema = z.object({
  nodes: z.array(
    tableRow(issues).pick({ id: true, status: true, priority: true, assigneeId: true }),
  ),
  edges: z.array(
    z.object({ from: z.string(), to: z.string(), kind: z.enum(issueDependencyKinds) }),
  ),
  rootIssueId: z.string().nullable(),
  depth: z.number(),
  truncated: z.boolean(),
  remainingNodes: z.number(),
});

export const readSnapshot = describeOperation({
  summary: "Read a compact digest of the project's pipeline state for a PM decision",
  description:
    'Issue counts by status, the live jobs, issues with no job under them, the queue depth, the latest failures and every runner with its load.',
  responses: { 200: json(snapshotSchema), 403: VIEWER, 404: NO_SUCH_PROJECT },
});

export const readGraph = describeOperation({
  summary: "Read the project's issue dependency graph, whole or out from one issue",
  description:
    'With `rootIssueId` the graph is walked `depth` steps out from it; without, it is the whole project, at most 200 nodes, with `truncated` and `remainingNodes` saying what was left out.',
  responses: { 200: json(graphSchema), 403: VIEWER, 404: NO_SUCH_PROJECT },
});

export const readRunners = describeOperation({
  summary: 'Read every runner on the project with the jobs currently occupying it',
  responses: { 200: json(runnerLoadSchema), 403: VIEWER, 404: NO_SUCH_PROJECT },
});
