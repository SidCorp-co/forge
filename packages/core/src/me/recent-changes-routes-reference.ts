import { z } from 'zod';
import { describeOperation, json } from '../api-reference/describe.js';

export const recentChangesSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      issSeq: z.number().int(),
      title: z.string(),
      status: z.string(),
      updatedAt: z.string(),
      projectSlug: z.string(),
      projectName: z.string(),
    }),
  ),
});

export const readRecentChanges = describeOperation({
  summary: 'List the most recently changed issues across the projects the caller can see',
  description: 'Archived issues are left out. Newest change first.',
  responses: { 200: json(recentChangesSchema) },
});
