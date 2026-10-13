import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { chatLogs } from '../db/schema.js';

export const chatLogSchema = tableRow(chatLogs);

export const chatLogListSchema = z.object({
  items: z.array(chatLogSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

const notMember = fail('FORBIDDEN', 'the caller is not a member of the project');
const needsAdmin = fail('FORBIDDEN', 'the caller holds less than project admin access');
const noProject = fail('NOT_FOUND', 'there is no project with that slug');

export const listChatLogs = describeOperation({
  summary: 'Page through chat logs, newest first, for one project or every project the caller sees',
  responses: {
    200: json(chatLogListSchema, 'One page of logs'),
    403: notMember,
    404: noProject,
  },
});

export const recentChatLogs = describeOperation({
  summary: "A project's latest chat logs, with long replies cut to 500 characters",
  responses: {
    200: json(z.array(chatLogSchema), 'Newest first'),
    403: notMember,
    404: noProject,
  },
});

export const flaggedChatLogs = describeOperation({
  summary: "A project's chat logs rated bad or flagged, newest first",
  responses: {
    200: json(z.array(chatLogSchema)),
    403: notMember,
    404: noProject,
  },
});

export const readChatLog = describeOperation({
  summary: 'Read one chat log',
  responses: {
    200: json(chatLogSchema),
    403: notMember,
    404: fail('NOT_FOUND', 'there is no such chat log, or its project is gone'),
  },
});

export const rateChatLog = describeOperation({
  summary: 'Set or clear the QA rating and notes of a chat log',
  description: 'Project admins only.',
  responses: {
    200: json(chatLogSchema, 'The log after the change'),
    403: needsAdmin,
    404: fail('NOT_FOUND', 'there is no such chat log, or its project is gone'),
  },
});
