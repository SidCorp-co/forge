import { z } from 'zod';
import { describeOperation, fail, json, NO_SUCH_PROJECT } from '../api-reference/declare/describe.js';
import { divergenceCharterEntrySchema } from './divergence-charters.js';

const charterSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  entries: z.array(divergenceCharterEntrySchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const readCharterSchema = z.object({
  charter: charterSchema.nullable().describe('Null until the project has a charter'),
});

export const savedCharterSchema = z.object({ charter: charterSchema });

export const readDivergenceCharter = describeOperation({
  summary: 'Read the record of intentional deviations a project keeps from the default pipeline',
  responses: {
    200: json(readCharterSchema),
    403: fail('FORBIDDEN', 'the caller is not a project member'),
    404: NO_SUCH_PROJECT,
  },
});

export const saveDivergenceCharter = describeOperation({
  summary: 'Replace the whole divergence charter of a project',
  description: 'The activity log records the change, with `reason` when one is sent.',
  responses: {
    200: json(savedCharterSchema, 'The charter as saved'),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: NO_SUCH_PROJECT,
  },
});
