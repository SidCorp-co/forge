// Client-facing contract for the Update Packet artifact (Update Pipeline §3,
// epic ISS-795 / ISS-799). The tuple is hardcoded here rather than imported
// from `@forge/core` (which has env side effects at import time), same as
// skill-activity.ts / pipeline-registry.ts / skill-facts.ts. A parity test in
// `packages/core/src/skills/update-packets.test.ts` keeps it in sync with
// `db/schema.ts`.

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

// cm:guard story must reject empty/whitespace-only — the one hard-blocking human input in the Update Pipeline (§3), no packet may be issued without it
export const createUpdatePacketInputSchema = z.object({
  change: z.string(),
  story: z.string().trim().min(1, 'story is required'),
  intentClass: z.enum(UPDATE_PACKET_INTENT_CLASSES),
  appliesTo: z.string().min(1),
  provenance: updatePacketProvenanceSchema.optional(),
});
export type CreateUpdatePacketInput = z.infer<typeof createUpdatePacketInputSchema>;
