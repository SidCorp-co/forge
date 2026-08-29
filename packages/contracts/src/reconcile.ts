// Client-facing contract for the Reconcile run artifact (Update Pipeline §②,
// epic ISS-795 / ISS-801). Tuples hardcoded here rather than imported from
// `@forge/core` (env side effects), same as skill-activity.ts. A parity test
// in `packages/core/src/skills/reconcile-service.test.ts` keeps them in sync
// with `db/schema.ts`.

import { z } from "zod";

export const RECONCILE_VERDICTS = [
	"no-op",
	"apply",
	"apply-with-adaptation",
	"escalate",
] as const;
export type ReconcileVerdict = (typeof RECONCILE_VERDICTS)[number];

export const RECONCILE_RUN_STATUSES = [
	"pending",
	"running",
	"verifying",
	"decided",
	"applied",
	"escalated",
	"failed",
] as const;
export type ReconcileRunStatus = (typeof RECONCILE_RUN_STATUSES)[number];

export const RECONCILE_GATES = ["auto", "human"] as const;
export type ReconcileGate = (typeof RECONCILE_GATES)[number];

export const reconcileVerifierVoteSchema = z.object({
	jobId: z.string(),
	vote: z.enum(["pass", "fail"]),
	reason: z.string(),
	decidedAt: z.string(),
});
export type ReconcileVerifierVote = z.infer<typeof reconcileVerifierVoteSchema>;

export const reconcileRunSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	packetId: z.string().nullable(),
	skillId: z.string().nullable(),
	status: z.enum(RECONCILE_RUN_STATUSES),
	verdict: z.enum(RECONCILE_VERDICTS).nullable(),
	gate: z.enum(RECONCILE_GATES).nullable(),
	candidateHash: z.string().nullable(),
	lastGoodHash: z.string().nullable(),
	verifierVotes: z.array(reconcileVerifierVoteSchema),
	rationale: z.string().nullable(),
	refusalReason: z.string().nullable(),
	error: z.string().nullable(),
	createdAt: z.union([z.string(), z.date()]),
	updatedAt: z.union([z.string(), z.date()]),
	decidedAt: z.union([z.string(), z.date()]).nullable(),
});
export type ReconcileRun = z.infer<typeof reconcileRunSchema>;

// cm:guard story must be present before a reconcile can be triggered (C1/C2 — passed in via packetId or directly)
export const triggerReconcileInputSchema = z.object({
	projectId: z.string().uuid(),
	/** The update packet driving this reconcile run. At least one of packetId or direct fields required (C1). */
	packetId: z.string().uuid().optional(),
	/** The skill to reconcile (by id or by name). If omitted, applies to the skill named in the packet's appliesTo. */
	skillId: z.string().uuid().optional(),
	skillName: z.string().min(1).optional(),
	/** Override the invariant set (base64-encoded JSON) — normally fetched live from the platform invariant registry. */
	invariantSetOverride: z.string().optional(),
});
export type TriggerReconcileInput = z.infer<typeof triggerReconcileInputSchema>;
