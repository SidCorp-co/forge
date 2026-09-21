import { z } from 'zod';

export const divergenceCharterEntrySchema = z.object({
  id: z.string().min(1),
  skill: z.string().min(1),
  difference: z.string().min(1),
  reason: z.string().min(1),
  /** Issue/commit references that document the incident (e.g. ['ISS-354', '148484a0']). */
  incidentRefs: z.array(z.string()),
  /** Whether this divergence may ever be reverted by a reconcile agent. */
  revertable: z.boolean(),
});
export type DivergenceCharterEntry = z.infer<typeof divergenceCharterEntrySchema>;

export const divergenceCharterSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  entries: z.array(divergenceCharterEntrySchema),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
});
export type DivergenceCharter = z.infer<typeof divergenceCharterSchema>;
