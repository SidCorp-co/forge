import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { agentSessionStatuses, agentSessions, sessionRuntimeStates } from '../db/schema.js';
import { sessionTranscripts } from '../db/session-vocabulary.js';
import { sessionReportSchema } from './box-report.js';

export const listQuerySchema = z
  .object({
    projectId: z.uuid().optional(),
    deviceId: z.uuid().optional(),
    status: z.enum(agentSessionStatuses).optional(),
    metadataType: z.string().min(1).max(100).optional(),
    issueId: z.uuid().optional(),
    archived: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const createSchema = z
  .object({
    projectId: z.uuid(),
    deviceId: z.uuid().nullable().optional(),
    title: z.string().max(500).nullable().optional(),
    repoPath: z.string().max(2000).nullable().optional(),
    claudeSessionId: z.string().max(500).nullable().optional(),
    metadata: z.unknown().optional(),
  })
  .strict();

export const patchSchema = z
  .object({
    title: z.string().max(500).nullable().optional(),
    status: z.enum(agentSessionStatuses).optional(),
    claudeSessionId: z.string().max(500).nullable().optional(),
    repoPath: z.string().max(2000).nullable().optional(),
    messages: z.array(z.unknown()).optional(),
    usage: z.unknown().optional(),
    metadata: z.unknown().optional(),
    diff: z.unknown().optional(),
    toolCallCount: z.number().int().min(0).optional(),
    turnError: z.string().max(4000).optional(),
    runtimeState: z.enum(sessionRuntimeStates).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

export const relayBodySchema = z
  .object({
    event: z.string().min(1).max(200),
    data: z.unknown(),
  })
  .strict();

export const queueStatsQuerySchema = z.object({ projectId: z.uuid() }).strict();
export const sweepQuerySchema = z.object({ projectId: z.uuid() }).strict();

/** A whole session, transcript included. */
export const sessionSchema = tableRow(agentSessions);

/** How long core lets this session go unheard before it ends it; `null` where no silence does. */
const silenceLimitMsSchema = z.number().int().nonnegative().nullable();

/** A session as a reader sees it: the row, what its box last reported about it, and core's silence limit. */
export const sessionReadSchema = sessionSchema.extend({
  report: sessionReportSchema,
  silenceLimitMs: silenceLimitMsSchema,
});

/** A session as a list shows it: no transcript, with its cost, the last line said and every issue
 *  it holds, named (its leases and its job's issue, as `held-issues.ts` reads them; empty where it
 *  holds none). */
export const sessionListItemSchema = sessionSchema.omit({ messages: true }).extend({
  issues: z.array(z.object({ id: z.string(), displayId: z.string(), title: z.string() })),
  messageCount: z.number().nullable(),
  transcript: z.enum(sessionTranscripts),
  estimatedCost: z.number(),
  lastMessagePreview: z.string().nullable(),
  report: sessionReportSchema,
  silenceLimitMs: silenceLimitMsSchema,
});

export const sessionListSchema = z.object({
  items: z.array(sessionListItemSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export const okSchema = z.object({ ok: z.literal(true) });
export const retriedSchema = z.object({ ok: z.literal(true), issueId: z.string() });
export const ackedSchema = z.object({
  sessionId: z.string(),
  acked: z.boolean(),
  already: z.boolean(),
});
export const relayedSchema = z.object({ relayed: z.literal(true) });

export const costSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  estimatedCost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  requests: z.number(),
  sampleCount: z.number(),
  models: z.array(z.object({ model: z.string(), cost: z.number(), requests: z.number() })),
});

export const queueStatsSchema = z.object({
  devices: z.array(
    z.object({ deviceId: z.string().nullable(), queued: z.number(), running: z.number() }),
  ),
});

export const zombieReapSchema = z.object({
  queueTimedOut: z.number(),
  turnNeverReported: z.number(),
  heartbeatTimedOut: z.number(),
  noClientAcked: z.number(),
});

const notMember = fail('FORBIDDEN', "the caller is not a member of the session's project");
const noSession = fail('NOT_FOUND', 'no such agent session, or its project');
const noProject = fail('NOT_FOUND', 'no such project');

export const listSessions = describeOperation({
  summary: 'List agent sessions, newest first, narrowed by project, device, status, kind or issue',
  description:
    'Without `projectId` the list covers every project the caller can see. Archived chats are left out unless `archived=true`. `metadataType` names a session kind.',
  responses: {
    200: json(sessionListSchema),
    400: fail('BAD_REQUEST', '`metadataType` names no session kind'),
    403: fail('FORBIDDEN', 'the caller is not a member of `projectId`'),
    404: noProject,
  },
});

export const createSession = describeOperation({
  summary: 'Open an empty chat session; the first turn goes through `send`',
  responses: {
    201: json(sessionSchema, 'The new session'),
    400: fail('BAD_REQUEST', '`metadata` sets `type`, which is the kind core writes'),
    403: fail('FORBIDDEN', 'the caller is below the project member role'),
    404: noProject,
  },
});

export const readSession = describeOperation({
  summary: 'Read one agent session with its transcript and what its box last reported about it',
  description:
    'A device may read only the session dispatched to it, which is how a runner fetches the baseline its patch appends onto.',
  responses: {
    200: json(sessionReadSchema),
    403: fail(
      'FORBIDDEN',
      'not a project member, not the conversation owner, or a device that does not own the session',
    ),
    404: noSession,
  },
});

export const ackSession = describeOperation({
  summary: 'Acknowledge, as the runner, that the session was received before the agent starts',
  description:
    'Device only, own session only. Idempotent: it flips a running session once and never revives a terminal one.',
  responses: {
    200: json(ackedSchema),
    403: fail('FORBIDDEN', 'the caller is not a device, or not the one the session is on'),
    404: noSession,
  },
});

export const patchSession = describeOperation({
  summary:
    'Write what a worker or the UI changed on a session: status, transcript, usage, metadata',
  description:
    'A device writes only its own session; a user needs the member role and to own the session or be a project admin. A session the user cancelled is not revived.',
  responses: {
    200: json(sessionSchema, 'The session after the change'),
    403: fail(
      'FORBIDDEN',
      'not the session owner, below the member role, or a device that does not own the session',
    ),
    404: noSession,
    409: fail('SESSION_CANCELLED', 'the patch would revive a session the user cancelled'),
  },
});

export const deleteSession = describeOperation({
  summary: 'Delete a session',
  description: 'The owner may delete their own chat; a project admin may delete any.',
  responses: {
    204: empty('Deleted'),
    403: fail('FORBIDDEN', 'the caller is not the session owner or a project admin'),
    404: noSession,
  },
});

export const relayToSession = describeOperation({
  summary: "Relay an event to the session's WebSocket room",
  responses: { 200: json(relayedSchema), 403: notMember, 404: noSession },
});

export const retrySession = describeOperation({
  summary: 'Re-enqueue the issue a pipeline session was working on',
  description: 'A no-op while a job for the issue is queued or running.',
  responses: {
    200: json(retriedSchema),
    400: fail({
      NOT_PIPELINE_SESSION: 'the session is not a pipeline session',
      NO_ISSUE_LINK: 'the session carries no issue',
    }),
    403: notMember,
    404: fail({
      NOT_FOUND: 'no such agent session, or its project',
      ISSUE_NOT_FOUND: 'the linked issue is gone',
    }),
  },
});

export const readSessionCost = describeOperation({
  summary: 'Read what a session cost, in total and per model',
  responses: { 200: json(costSchema), 403: notMember, 404: noSession },
});

export const readQueueStats = describeOperation({
  summary: "Count a project's queued and running sessions per device",
  responses: {
    200: json(queueStatsSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: noProject,
  },
});

export const sweepZombies = describeOperation({
  summary: 'Reap stuck sessions of a project now instead of waiting for the loop monitor',
  responses: {
    200: json(zombieReapSchema, 'How many sessions each pass reaped'),
    403: fail('FORBIDDEN', 'the caller is below the project admin role'),
    404: noProject,
  },
});
