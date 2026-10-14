import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { notificationDeliveries, notificationTypes } from '../db/schema.js';

const NOT_FOUND = 'The notification is not one of the caller’s own';

export const openCountSchema = z.object({
  count: z.number().describe('Distinct records still true for the caller'),
});

export const markAllReadSchema = z.object({ updated: z.number() });

export const closedSchema = z.object({
  closed: z.number().describe('Tasks this delivery carried that are now closed'),
});

/** One bell row: a delivery with the figures of the records it carries. */
export const deliveryListItemSchema = z.object({
  id: z.string(),
  readAt: z.date().nullable(),
  unread: z
    .boolean()
    .describe(
      'Still asks to be read: no `readAt`, not a resolved notice, and carrying an event or a record that is still true',
    ),
  groupKey: z.string().nullable(),
  resolvedNotice: z.boolean(),
  createdAt: z.date(),
  members: z.number().describe('Records the delivery carries'),
  openMembers: z.number().describe('Of those, the ones still true'),
  type: z.string(),
  kind: z.string(),
  tier: z.string(),
  title: z
    .string()
    .describe(
      'The record’s own title for one record, the cause for several, which name no one issue',
    ),
  body: z
    .string()
    .nullable()
    .describe('Only what is specific to a single record; null for several'),
  explanation: z
    .string()
    .nullable()
    .describe('What the sweep that wrote this means and what to do, once, from its detector'),
  severity: z.string().nullable(),
  projectId: z.string().nullable().describe('Null where the records span projects'),
  projectSlug: z.string().nullable(),
  projectName: z.string().nullable(),
  issueId: z.string().nullable().describe('Null where the delivery carries several records'),
  secondaryIssueId: z.string().nullable(),
  agentSessionId: z.string().nullable(),
  notificationId: z.string(),
});

export const deliveryListSchema = z.object({
  items: z.array(deliveryListItemSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export const deliveryRowSchema = tableRow(notificationDeliveries);

/** One record behind a delivery. */
export const deliveryMemberSchema = z.object({
  id: z.string(),
  type: z.enum(notificationTypes),
  kind: z.enum(['signal', 'condition', 'task']),
  state: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  severity: z.string().nullable(),
  projectId: z.string().nullable(),
  projectSlug: z.string().nullable(),
  projectName: z.string().nullable(),
  issueId: z.string().nullable(),
  secondaryIssueId: z.string().nullable(),
  resolvedAt: z.date().nullable(),
  createdAt: z.date(),
  open: z.boolean(),
});

export const deliveryMembersSchema = z.array(deliveryMemberSchema);

export const openCount = describeOperation({
  summary: 'Count the things still true for the caller',
  description:
    'Counts distinct records, not deliveries: a grouped delivery of fifteen firing conditions reads fifteen. Signals never count.',
  responses: { 200: json(openCountSchema) },
});

export const markAllRead = describeOperation({
  summary: 'Mark every unread notification of the caller read',
  description:
    "Takes no body fields: it marks every project's notifications read, so a `projectId` is refused rather than ignored.",
  responses: { 200: json(markAllReadSchema, 'How many deliveries were marked') },
});

export const listNotifications = describeOperation({
  summary: 'List the caller’s notifications, newest first',
  description:
    'One row per delivery. `type` and `unread=true` narrow the list before it is paged, so the total and every page count only the matches.',
  responses: { 200: json(deliveryListSchema, 'One page of deliveries, with the list envelope') },
});

export const patchNotification = describeOperation({
  summary: 'Mark one notification read or unread',
  description: 'Writes only `readAt`. It never resolves a condition or closes a task.',
  responses: {
    200: json(deliveryRowSchema, 'The delivery as it now stands'),
    404: fail('NOT_FOUND', NOT_FOUND),
  },
});

export const notificationMembers = describeOperation({
  summary: 'List the records behind one notification, still-true ones first',
  responses: {
    200: json(deliveryMembersSchema),
    404: fail('NOT_FOUND', NOT_FOUND),
  },
});

export const doneNotification = describeOperation({
  summary: 'Mark the tasks of one notification done',
  description: 'Conditions and signals it carries are untouched.',
  responses: {
    200: json(closedSchema),
    404: fail('NOT_FOUND', NOT_FOUND),
  },
});

export const dismissNotification = describeOperation({
  summary: 'Dismiss the tasks of one notification',
  description: 'Conditions and signals it carries are untouched.',
  responses: {
    200: json(closedSchema),
    404: fail('NOT_FOUND', NOT_FOUND),
  },
});

export const deleteNotification = describeOperation({
  summary: 'Delete one notification from the caller’s bell',
  responses: {
    204: empty(),
    404: fail('NOT_FOUND', NOT_FOUND),
    409: fail(
      'CONDITION_STILL_TRUE',
      'It carries a condition that is still true; silence it instead of deleting it',
    ),
  },
});
