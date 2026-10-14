import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { agentSessionStatuses } from '../db/schema.js';
import { sessionTranscripts } from '../db/session-vocabulary.js';
import { sessionSchema } from './routes-reference.js';

export const paramSchema = z.object({ id: z.uuid() });
export const sessionParamSchema = z.object({ id: z.uuid(), sessionId: z.uuid() });

export const listQuerySchema = z.object({
  issueId: z.uuid().optional(),
  status: z.enum(agentSessionStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

/** The lean row of the session list: no transcript, usage, diff or pipeline blobs. */
export const sessionSummarySchema = sessionSchema
  .pick({
    id: true,
    projectId: true,
    userId: true,
    deviceId: true,
    pipelineRunId: true,
    title: true,
    status: true,
    claudeSessionId: true,
    repoPath: true,
    metadata: true,
    kind: true,
    parentSessionId: true,
    failureReason: true,
    dispatchedAt: true,
    startedAt: true,
    lastHeartbeatAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({ messageCount: z.number().nullable(), transcript: z.enum(sessionTranscripts) });

/** Rows are trimmed to the response-size cap, and then `truncated`, `truncatedBy` and `notice` say so. */
export const projectSessionsSchema = z.object({
  sessions: z.array(sessionSummarySchema),
  returned: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  truncated: z.literal(true).optional(),
  truncatedBy: z.enum(['limit', 'response-size', 'limit+response-size']).optional(),
  notice: z.string().optional(),
});

const notMember = fail('FORBIDDEN', 'the caller is not a member of the project');

export const listProjectSessions = describeOperation({
  summary: "List a project's agent sessions without transcripts, newest first",
  description:
    'Ordered by `updatedAt`, newest first. A response cut short by `limit` or by the response-size cap carries `nextCursor`; pass it back as `cursor` and repeat until it is `null`, which is also when `hasMore` is false. A session whose `updatedAt` moves while you read, as every heartbeat moves it, jumps to the head of the order, so a session you had not yet read can be missed by a walk that is still running.',
  responses: {
    200: json(projectSessionsSchema),
    400: fail('BAD_REQUEST', 'a query value is not valid, among them a `cursor` this list did not mint'),
    403: notMember,
    404: fail('NOT_FOUND', 'no such project'),
  },
});

export const sessionDetailSchema = z.object({
  session: sessionSchema.omit({ messages: true }).extend({
    messageCount: z.number().nullable(),
    totalMessages: z.number().nullable(),
    transcript: z.enum(sessionTranscripts),
    messages: z.array(z.unknown()),
  }),
});

export const readProjectSession = describeOperation({
  summary: 'Read one session of a project with the last 20 messages of its transcript',
  description:
    '`totalMessages` is the length of the whole transcript, and equals `messageCount`. Both are `null` when `transcript` is `not-recorded`: master and run_session sessions keep no transcript in core, so no count is a count of what they did.',
  responses: {
    200: json(sessionDetailSchema),
    403: notMember,
    404: fail('NOT_FOUND', 'no such project, or no such session in it'),
  },
});
