import { z } from 'zod';
import { memoryWritableSources } from '../db/schema.js';

/** The natural key a memory is deleted by, trimmed as every other memory door keys it. */
export const deleteMemoryInputSchema = z.object({
  projectId: z.uuid(),
  source: z.enum(memoryWritableSources),
  sourceRef: z.string().trim().min(1).max(512),
});
