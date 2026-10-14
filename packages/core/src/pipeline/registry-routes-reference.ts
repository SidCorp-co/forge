import { z } from 'zod';
import { describeOperation, json } from '../api-reference/declare/describe.js';

export const registrySchema = z.object({
  version: z.number(),
  runnerCapabilities: z.record(z.string(), z.array(z.string()).readonly()),
  statusExits: z.record(z.string(), z.array(z.string()).readonly()),
});

export const readRegistry = describeOperation({
  summary:
    'Read which job types each runner type can take and which statuses each status may move to',
  responses: { 200: json(registrySchema) },
});
