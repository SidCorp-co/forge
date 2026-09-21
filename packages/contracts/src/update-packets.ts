import { z } from 'zod';

export const UPDATE_PACKET_INTENT_CLASSES = ['invariant', 'procedure', 'enhancement'] as const;
export type UpdatePacketIntentClass = (typeof UPDATE_PACKET_INTENT_CLASSES)[number];

export const updatePacketProvenanceSchema = z.object({
  commit: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
});
export type UpdatePacketProvenance = z.infer<typeof updatePacketProvenanceSchema>;

export const updatePacketSchema = z.object({
  id: z.string(),
  change: z.string(),
  story: z.string().min(1),
  intentClass: z.enum(UPDATE_PACKET_INTENT_CLASSES),
  appliesTo: z.string().min(1),
  provenance: updatePacketProvenanceSchema,
  createdAt: z.union([z.string(), z.date()]),
});
export type UpdatePacket = z.infer<typeof updatePacketSchema>;

export const createUpdatePacketInputSchema = z.object({
  change: z.string(),
  story: z.string().trim().min(1, 'story is required'),
  intentClass: z.enum(UPDATE_PACKET_INTENT_CLASSES),
  appliesTo: z.string().min(1),
  provenance: updatePacketProvenanceSchema.optional(),
});
export type CreateUpdatePacketInput = z.infer<typeof createUpdatePacketInputSchema>;
