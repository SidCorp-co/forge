import { z } from 'zod';
import { describeOperation, json } from '../api-reference/declare/describe.js';

const collaboratorSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerifiedAt: z.date().nullable(),
  createdAt: z.date(),
  memberships: z.array(
    z.object({ projectId: z.string(), projectSlug: z.string(), role: z.string() }),
  ),
});

export const collaboratorsSchema = z.object({
  users: z.array(collaboratorSchema),
  total: z.number(),
});

export const listCollaborators = describeOperation({
  summary: 'List the people the caller shares a project with, and the roles they hold there',
  description:
    'Only projects the caller can see count. `search` matches the start of an email; `limit` defaults to 50 and `offset` to 0.',
  responses: {
    200: json(collaboratorsSchema, 'A page of collaborators and the total match count'),
  },
});
