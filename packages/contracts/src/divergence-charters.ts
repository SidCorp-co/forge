// Client-facing contract for the divergence charter (Update Pipeline §5,
// epic ISS-795 / ISS-800). Tuples hardcoded here rather than imported from
// `@forge/core` (env side effects), same as skill-activity.ts. A parity test
// in `packages/core/src/skills/divergence-charters.test.ts` keeps them in
// sync with `db/schema.ts`.

import { z } from "zod";

/** One intentional deviation entry authored by the project owner. */
export const divergenceCharterEntrySchema = z.object({
	/** Stable kebab-case identifier for reference in the Master agent bundle. */
	id: z.string().min(1),
	/** Which skill/stage this divergence applies to (e.g. 'forge-release'). */
	skill: z.string().min(1),
	/** Human-readable statement of the intentional difference. */
	difference: z.string().min(1),
	/** Why the difference was made (incident, design decision). */
	reason: z.string().min(1),
	/** Issue/commit references that document the incident (e.g. ['ISS-354', '148484a0']). */
	incidentRefs: z.array(z.string()),
	/** Whether this divergence may ever be reverted by a reconcile agent. */
	revertable: z.boolean(),
});
export type DivergenceCharterEntry = z.infer<
	typeof divergenceCharterEntrySchema
>;

export const divergenceCharterSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	entries: z.array(divergenceCharterEntrySchema),
	createdAt: z.union([z.string(), z.date()]),
	updatedAt: z.union([z.string(), z.date()]),
});
export type DivergenceCharter = z.infer<typeof divergenceCharterSchema>;
