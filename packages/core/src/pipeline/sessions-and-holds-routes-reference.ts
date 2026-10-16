import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { issueStatuses } from '../db/schema.js';

export const paramSchema = z.object({ id: z.uuid() });

const issueRefSchema = z.object({
  issueId: z.string(),
  displayId: z.string(),
  title: z.string(),
});

const liveSessionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string().nullable(),
  jobType: z.string().nullable(),
  skillName: z.string().nullable(),
  status: z.string(),
  runtimeState: z.string().nullable(),
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  startedAt: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  createdAt: z.string(),
  issues: z.array(issueRefSchema),
  report: z
    .object({
      incarnation: z.string(),
      work: z.string(),
      blockerKind: z.string().nullable(),
      waitingOn: z.string().nullable(),
      observedAt: z.string(),
    })
    .nullable(),
  silenceLimitMs: z.number().int().nonnegative().nullable(),
});

const holderSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('session'),
    sessionId: z.string(),
    sessionTitle: z.string().nullable(),
    sessionKind: z.string(),
    deviceName: z.string().nullable(),
    since: z.string(),
  }),
  z.object({
    by: z.literal('claim'),
    holder: z.string(),
    renewedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    next: z.string().nullable(),
  }),
  z.object({
    by: z.literal('person'),
    status: z.enum(issueStatuses),
    owes: z.enum(['information', 'decision', 'resource']).nullable(),
    since: z.string().nullable(),
    why: z.string().nullable(),
  }),
]);

export const sessionsAndHoldsSchema = z.object({
  sessions: z.array(liveSessionSchema),
  holds: z.array(issueRefSchema.extend({ status: z.string(), holders: z.array(holderSchema) })),
  readAt: z.string(),
});

export const readProjectSessionsAndHolds = describeOperation({
  summary: "Read a project's live agent sessions and the issues held on it",
  description:
    "`sessions` is every session of the project that has not ended, chat sessions excepted, each with the job type and skill a step session was opened under (`jobType`, `skillName`, `null` for any other), the issues it holds (those it leases, or a step session's job's issue) and the box's own last report (`report`, `null` where the box reported none) and how long core lets it go unheard before it ends it (`silenceLimitMs`, `null` where no silence ends it). `holds` is one entry per issue held by a live session, by a claim whose verdict is live, or by a person (`needs_info`, `waiting`, `on_hold`). An archived issue is neither held nor listed under a session. A claim records no time it began, so it carries `renewedAt`, its last renewal; a person's `owes` and `since` are `null` where the park did not record them.",
  responses: {
    200: json(sessionsAndHoldsSchema),
    400: fail('BAD_REQUEST', 'the project id is not a UUID'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'no such project'),
  },
});
