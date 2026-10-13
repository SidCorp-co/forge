import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { skillActivityEventTypes } from '../db/schema.js';

/** The history is capped rather than whole: ISS-1025 found every view an unbounded read of the log. */
export const DEFAULT_ACTIVITY_LIMIT = 200;
export const MAX_ACTIVITY_LIMIT = 1000;

export const activityQuerySchema = z.object({
  projectId: z.uuid().optional(),
  skillId: z.uuid().optional(),
  deviceId: z.uuid().optional(),
  packetId: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_ACTIVITY_LIMIT, `limit must not exceed ${MAX_ACTIVITY_LIMIT}`)
    .default(DEFAULT_ACTIVITY_LIMIT),
});

const eventSchema = z.object({
  id: z.string(),
  occurredAt: z.date(),
  packetId: z.string().nullable(),
  projectId: z.string().nullable(),
  skillId: z.string().nullable(),
  deviceId: z.string().nullable(),
  eventType: z.enum(skillActivityEventTypes),
  actor: z.string(),
  trigger: z.string(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  deltaSummary: z.string().nullable(),
  reason: z.string().nullable(),
  outcome: z.string(),
});

const page = {
  events: z.array(eventSchema).describe('The most recent events under the cap, oldest first'),
  limit: z.number().describe('The cap this answer was read under'),
  truncated: z.boolean().describe('Older events matched and were left out'),
};

export const activitySchema = z.discriminatedUnion('view', [
  z.object({
    view: z.literal('by-packet'),
    packetId: z.string(),
    ...page,
    summary: z.record(z.string(), z.number()).describe('Event count per event type, whole packet'),
  }),
  z.object({
    view: z.literal('by-device'),
    projectId: z.string(),
    deviceId: z.string(),
    ...page,
  }),
  z.object({
    view: z.literal('by-skill'),
    projectId: z.string(),
    skillId: z.string().nullable().describe('Null when the view covers every skill of the project'),
    ...page,
  }),
]);

const brokenChainSchema = z.object({
  projectId: z.string(),
  skillId: z.string(),
  eventId: z.string(),
  occurredAt: z.string(),
  expectedBeforeHash: z.string(),
  actualBeforeHash: z.string().nullable(),
});

export const chainIntegritySchema = z.object({
  ok: z.boolean(),
  brokenChains: z.array(brokenChainSchema),
  skillHashMismatches: z.array(
    z.object({
      projectId: z.string(),
      skillId: z.string(),
      loggedHash: z.string().nullable(),
      currentHash: z.string(),
    }),
  ),
  deviceHashMismatches: z.array(
    z.object({
      deviceId: z.string(),
      projectId: z.string(),
      skillId: z.string(),
      loggedHash: z.string().nullable(),
      installedHash: z.string(),
    }),
  ),
});

const adminRefusals = {
  401: fail('UNAUTHENTICATED', 'the user behind the credential no longer exists'),
  403: fail({
    ADMIN_ONLY: 'a `packetId` view was asked by a caller who is not a platform administrator',
    FORBIDDEN: 'the caller is not a member of the project',
  }),
} as const;

export const readSkillActivity = describeOperation({
  summary: 'Read the skill-update activity log as one of three views, chosen by the filter sent',
  description:
    '`packetId` gives the by-packet rollup across every adopting project (administrators only); `projectId` with `deviceId` gives what one device received; `projectId` alone, with an optional `skillId`, gives the content timeline.',
  responses: {
    200: json(activitySchema, 'The view, with the cap it was read under'),
    400: fail(
      'BAD_REQUEST',
      'a filter is malformed, or none of `projectId` and `packetId` was sent',
    ),
    ...adminRefusals,
  },
});

export const readSkillActivityChainIntegrity = describeOperation({
  summary:
    'Check that the activity log chains onto the skill bodies and device installs it records',
  responses: {
    200: json(chainIntegritySchema, '`ok` is true when no link is broken and no hash differs'),
    401: fail('UNAUTHENTICATED', 'the user behind the credential no longer exists'),
    403: fail('ADMIN_ONLY', 'the caller is not a platform administrator'),
  },
});
