import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const paramsSchema = z.object({ id: z.uuid() });

export const runSessionRowSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  sessionId: z.string().nullable(),
  masterSessionId: z.string().nullable(),
  pid: z.number().nullable(),
  worktreePath: z.string(),
  bootId: z.string(),
  incarnation: z.string(),
  work: z.string(),
  blockerKind: z.string().nullable(),
  waitingOn: z.string().nullable(),
  issues: z.array(z.object({ issueKey: z.string(), leaseReturned: z.boolean() })),
  sessionTerminalAt: z.string().nullable(),
  worktreeGoneAt: z.string().nullable(),
  deviceId: z.string(),
  deviceName: z.string().nullable(),
  observedAt: z.string(),
  sessionStatus: z.string().nullable(),
  sessionFailureReason: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  masterTitle: z.string().nullable(),
});

export const runSessionsSchema = z.object({
  items: z.array(runSessionRowSchema),
  count: z.number(),
});

export const listProjectRunSessions = describeOperation({
  summary: 'List the agent runs the fleet has reported for a project, newest report first',
  description: "`sessionStatus` is core's own reading of the session, never the box's claim.",
  responses: {
    200: json(runSessionsSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'no such project'),
  },
});
