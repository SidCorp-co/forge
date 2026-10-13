import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';

export const mineSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      textContent: z.string(),
      metadata: z.unknown().describe('Free-form JSON; carries `authorUserId`'),
      createdAt: z.date(),
      updatedAt: z.date(),
    }),
  ),
});

export const listMyNotes = describeOperation({
  summary: 'List the notes the assistant remembered for the caller, newest first',
  description:
    'At most 200 notes. Notes of a project the caller can no longer read are left out; `projectId` narrows to one project.',
  responses: { 200: json(mineSchema, 'The live notes of the caller') },
});

export const deleteMyNote = describeOperation({
  summary: "Take back one of the caller's own notes",
  responses: {
    204: empty(),
    403: fail('FORBIDDEN', 'the caller is no longer a member of the project of the note'),
    404: fail('NOT_FOUND', 'the caller has no note with that id'),
  },
});
