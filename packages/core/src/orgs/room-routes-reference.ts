import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { conversationShapes } from '../db/schema-conversations.js';

export const orgRoomsParamSchema = z.object({ orgId: z.uuid() });

/** A room the organization holds that is about no project any more (ISS-1229 r23). */
export const roomWithoutAProjectSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  shape: z.enum(conversationShapes),
  archivedAt: z.date().nullable(),
  updatedAt: z.date(),
});

export const listRoomsWithoutAProject = describeOperation({
  summary:
    "List the organization's rooms whose every project is gone, those the caller opened or, for an admin of the organization, all of them, with any room the caller opened whose organization nothing records",
  description:
    "A room outlives its project as its organization's. Each one listed is deleted with `DELETE /api/conversations/:id`, which admits the same callers.",
  responses: {
    200: json(z.array(roomWithoutAProjectSchema)),
    403: fail('FORBIDDEN', 'the caller is not a member of the organization'),
    404: fail('NOT_FOUND', 'no such organization'),
  },
});
