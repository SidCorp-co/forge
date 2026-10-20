import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { ISSUE_REF_REFUSALS } from './search-reference.js';

/** Who did something, as a person or a paired device's agent. */
export const resolvedActorSchema = z.object({
  type: z.enum(['user', 'device']),
  id: z.string(),
  displayName: z.string(),
  isAgent: z.boolean(),
  deviceId: z.string().optional(),
  ownerName: z.string().optional(),
});

export const activityRowSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  action: z.string(),
  actorType: z.string(),
  actorAgency: z.enum(['human', 'agent']),
  actorId: z.string(),
  payload: z.unknown(),
  createdAt: z.date(),
  actor: resolvedActorSchema.nullable(),
});

/** Newest first; `nextBefore` is the oldest row's time, to send back as `before`, null at the end. */
export const activityPageSchema = z.object({
  items: z.array(activityRowSchema),
  nextBefore: z.string().nullable(),
});

export const readIssueActivity = describeOperation({
  summary: "List an issue's activity, newest first",
  responses: { 200: json(activityPageSchema), ...ISSUE_REF_REFUSALS },
});

export const readProjectActivity = describeOperation({
  summary: "List a project's activity across its issues, newest first",
  description:
    'Archived issues are left out. `type` keeps the actions that begin `issue.`, `comment.` or `member.`.',
  responses: {
    200: json(activityPageSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const evaluateActivity = describeOperation({
  summary: 'Record a verdict on one activity entry',
  responses: {
    200: json(activityRowSchema, 'The entry, with the verdict in its payload under `evaluation`'),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the entry does not exist, or is not on this issue'),
  },
});

export const deleteActivity = describeOperation({
  summary: 'Delete one activity entry',
  responses: {
    204: empty(),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', 'the entry does not exist, or is not on this issue'),
  },
});
