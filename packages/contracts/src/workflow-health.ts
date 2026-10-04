// One declaration of how a record names a node of a design (workflow step-health, REQ-17): a step by
// its id, or an edge by its from and to steps, with its label where several edges share both ends.

import { z } from "zod";

export const WORKFLOW_STEP_ID = /^[a-z][a-z0-9_-]{0,62}$/;

const stepId = z.string().regex(WORKFLOW_STEP_ID, "a step id reads like `my-step`");

export const edgeRefSchema = z.strictObject({
	from: stepId,
	to: stepId,
	label: z.string().trim().min(1).max(120).optional(),
});
export type EdgeRef = z.infer<typeof edgeRefSchema>;

export const nodeRefSchema = z.union([
	z.strictObject({ step: stepId }),
	z.strictObject({ edge: edgeRefSchema }),
]);
export type NodeRef = z.infer<typeof nodeRefSchema>;

/** The steps and edges a record is about; at least one of the two lists is non-empty where it is required. */
export const nodeSetSchema = z.strictObject({
	steps: z.array(stepId).max(40).optional(),
	edges: z.array(edgeRefSchema).max(120).optional(),
});
export type NodeSet = z.infer<typeof nodeSetSchema>;

export const NODE_DECISION_VERDICTS = ["keep", "rewrite", "delete"] as const;
export type NodeDecisionVerdict = (typeof NODE_DECISION_VERDICTS)[number];

/** `decision.node` on a workflow decision comment: the node decided and what is done with it. */
export const nodeDecisionSchema = z.union([
	z.strictObject({ step: stepId, verdict: z.enum(NODE_DECISION_VERDICTS) }),
	z.strictObject({
		edge: edgeRefSchema,
		verdict: z.enum(NODE_DECISION_VERDICTS),
	}),
]);
export type NodeDecision = z.infer<typeof nodeDecisionSchema>;

export const NODE_DECISION_SHAPE = `{ step, verdict } | { edge: { from, to, label? }, verdict } with verdict ${NODE_DECISION_VERDICTS.join(" | ")}`;

export const DESIGN_CHANGE_KINDS = ["change", "remove", "rewire"] as const;
export type DesignChangeKind = (typeof DESIGN_CHANGE_KINDS)[number];

/** A `design_change` suggestion's payload: the nodes it is about, what it asks for and why. */
export const designChangePayloadSchema = z
	.strictObject({
		steps: z.array(stepId).max(40).optional(),
		edges: z.array(edgeRefSchema).max(120).optional(),
		change: z.enum(DESIGN_CHANGE_KINDS),
		reason: z.string().trim().min(1).max(4_000),
	})
	.refine((p) => (p.steps?.length ?? 0) + (p.edges?.length ?? 0) > 0, {
		message: "a design_change names at least one step or edge",
		path: ["steps"],
	});
export type DesignChangePayload = z.infer<typeof designChangePayloadSchema>;

/** Refused on any write naming a node: none of the design's latest revision, or an edge whose ends several edges share and whose label is not given. */
export const WORKFLOW_NODE_REFUSAL_CODES = [
	"WORKFLOW_NODE_UNKNOWN",
	"WORKFLOW_NODE_AMBIGUOUS",
] as const;
export type WorkflowNodeRefusalCode =
	(typeof WORKFLOW_NODE_REFUSAL_CODES)[number];

/** `PUT /api/projects/:id/requirements/:req/criteria/:code/steps` — replaces the criterion's trace onto one design. */
export const putCriterionStepsRequestSchema = z.strictObject({
	workflow: z.string().trim().min(1).max(200),
	steps: z.array(stepId).max(40).optional(),
	edges: z.array(edgeRefSchema).max(120).optional(),
});
export type PutCriterionStepsRequest = z.infer<
	typeof putCriterionStepsRequestSchema
>;
export const PUT_CRITERION_STEPS_SHAPE =
	"{ workflow, steps?: string[], edges?: { from, to, label? }[] } — the whole trace of this criterion onto that linked design; empty lists clear it";

/** One criterion's trace onto one design, as the requirement read serves it. */
export interface CriterionTraceView {
	workflowId: string;
	flow: string;
	steps: string[];
	edges: EdgeRef[];
}

/** The key a node is matched by everywhere: `step:<id>` or `edge:<from>><to>` with `#<label>` when given. */
export function nodeKeyOf(ref: NodeRef): string {
	if ("step" in ref) return `step:${ref.step}`;
	const { from, to, label } = ref.edge;
	return `edge:${from}>${to}${label ? `#${label}` : ""}`;
}

/** An observed layer may be larger than its design: code the design does not hold is drawn too. */
export const OBSERVATION_LIMITS = { steps: 200, edges: 600, after: 24 } as const;

export const OBSERVATION_SOURCES = ["observer", "migrated"] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

/** Every refusal an observation write answers with, by name; nothing of a refused observation is stored. */
export const OBSERVATION_REFUSAL_CODES = [
	"WORKFLOW_OBSERVATION_UNCITED",
	"WORKFLOW_OBSERVATION_STEP_DUPLICATE",
	"WORKFLOW_OBSERVATION_MATCH_UNKNOWN",
	"WORKFLOW_OBSERVATION_MATCH_DUPLICATE",
	"WORKFLOW_OBSERVATION_EDGE_DANGLING",
	"WORKFLOW_OBSERVATION_DRIFT_UNKNOWN",
	"WORKFLOW_OBSERVATION_REVISION_UNKNOWN",
	"WORKFLOW_OBSERVATION_CITATION_KIND_MISMATCH",
	"WORKFLOW_WRITER_NOT_PROJECT",
] as const;
export type ObservationRefusalCode = (typeof OBSERVATION_REFUSAL_CODES)[number];

/** One observation as a list serves it. */
export interface ObservationSummaryView {
	id: string;
	workflowId: string;
	flow: string;
	atSha: string;
	revision: number;
	source: ObservationSource;
	stepCount: number;
	edgeCount: number;
	matched: number;
	writtenBy: string;
	writtenByName: string | null;
	createdAt: string;
}

/** One observation with its observed steps and edges. */
export interface ObservationView extends ObservationSummaryView {
	document: {
		summary?: string | undefined;
		steps: unknown[];
		edges: unknown[];
		drift: { steps: string[]; reason: string } | null;
	};
}
