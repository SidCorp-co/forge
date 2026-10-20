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
  createdAt: z.date(),
  updatedAt: z.date(),
  /** The projects deleted while the room was about them; empty where it was orphaned before 0353. */
  deletedProjectNames: z.array(z.string()),
  /** When the last message was said in it; null where nothing was. */
  lastMessageAt: z.date().nullable(),
});

export const listRoomsWithoutAProject = describeOperation({
  summary:
    "List the organization's rooms whose every project is gone, those the caller opened or, for an admin of the organization, all of them; under the caller's personal workspace, also any room they opened that no organization of theirs holds",
  description:
    "A room outlives its project as its organization's. Each one listed is deleted with `DELETE /api/conversations/:id`, which admits the same callers.",
  responses: {
    200: json(z.array(roomWithoutAProjectSchema)),
    403: fail('FORBIDDEN', 'the caller is not a member of the organization'),
    404: fail('NOT_FOUND', 'no such organization'),
  },
});
