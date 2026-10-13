import { z } from 'zod';
import {
  describeOperation,
  empty,
  fail,
  json,
  NO_SUCH_PROJECT,
} from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { agents } from '../db/schema.js';

export const agentSchema = tableRow(agents);

export const agentListSchema = z.object({
  items: z.array(agentSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

const notMember = fail('FORBIDDEN', 'the caller is not a member of the project');
const needsRole = (role: string) =>
  fail('FORBIDDEN', `the caller holds less than project ${role} access`);

export const listAgents = describeOperation({
  summary: "List a project's agents, oldest first, optionally by type or enabled state",
  responses: {
    200: json(agentListSchema, 'Every matching agent'),
    403: notMember,
    404: NO_SUCH_PROJECT,
  },
});

export const createAgent = describeOperation({
  summary: 'Create an agent in a project; it starts disabled unless `enabled` is sent',
  responses: {
    201: json(agentSchema, 'The new agent'),
    403: needsRole('member'),
    404: NO_SUCH_PROJECT,
  },
});

export const readAgent = describeOperation({
  summary: 'Read one agent',
  responses: {
    200: json(agentSchema),
    403: notMember,
    404: fail('NOT_FOUND', 'there is no such agent'),
  },
});

export const updateAgent = describeOperation({
  summary: 'Change the fields sent on an agent',
  responses: {
    200: json(agentSchema, 'The agent after the change'),
    403: needsRole('member'),
    404: fail('NOT_FOUND', 'there is no such agent'),
  },
});

export const deleteAgent = describeOperation({
  summary: 'Delete an agent',
  responses: {
    204: empty(),
    403: fail('FORBIDDEN', 'the caller holds less than project admin access'),
    404: fail('NOT_FOUND', 'there is no such agent'),
  },
});
