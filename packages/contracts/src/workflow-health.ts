// One declaration of how a record names a node of a design (workflow step-health, REQ-17): a step by
// its id, or an edge by its from and to steps, with its label where several edges share both ends.

import { z } from "zod";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";
import type { WaitingOn } from "./standing.js";

export const WORKFLOW_STEP_ID = /^[a-z][a-z0-9_-]{0,62}$/;

const stepId = z
	.string()
	.regex(WORKFLOW_STEP_ID, "a step id reads like `my-step`");

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

/** Which layer a node is read from: the approved design, or the latest observation of the code. */
export const NODE_LAYERS = ["planned", "observed"] as const;
export type NodeLayer = (typeof NODE_LAYERS)[number];

/**
 * The seven marker kinds (REQ-17 BC-3), in the order a node draws its dots: four read from evidence
 * records, three from planned against observed.
 */
export const HEALTH_MARKER_KINDS = [
	"has_problem",
	"wrong",
	"outdated",
	"not_in_design",
	"remove_proposed",
	"needs_update",
	"upcoming",
] as const;
export type HealthMarkerKind = (typeof HEALTH_MARKER_KINDS)[number];

export const HEALTH_MARKER_LABELS: Record<HealthMarkerKind, string> = {
	outdated: "Outdated",
	needs_update: "Needs update",
	has_problem: "Has a problem",
	remove_proposed: "Removal proposed",
	upcoming: "Upcoming",
	not_in_design: "Not in design",
	wrong: "Wrong",
};

export const EVIDENCE_MARKER_KINDS = [
	"outdated",
	"needs_update",
	"has_problem",
	"remove_proposed",
] as const satisfies readonly HealthMarkerKind[];
export const PROVENANCE_MARKER_KINDS = [
	"upcoming",
	"not_in_design",
	"wrong",
] as const satisfies readonly HealthMarkerKind[];

const decisionFields = {
	verdict: z.enum(NODE_DECISION_VERDICTS),
	/** Absent is `planned`: a step or edge of the approved revision. `observed` names a node of the latest observation, so a Not in design node can be decided. */
	layer: z.enum(NODE_LAYERS).optional(),
	/** The marker the node carried when it was decided. */
	marker: z.enum(HEALTH_MARKER_KINDS).optional(),
};

/** `decision.node` on a workflow decision comment: the node decided and what is done with it. */
export const nodeDecisionSchema = z.union([
	z.strictObject({ step: stepId, ...decisionFields }),
	z.strictObject({ edge: edgeRefSchema, ...decisionFields }),
]);
export type NodeDecision = z.infer<typeof nodeDecisionSchema>;

export const NODE_DECISION_SHAPE = `{ step, verdict, layer?, marker? } | { edge: { from, to, label? }, verdict, layer?, marker? } with verdict ${NODE_DECISION_VERDICTS.join(" | ")}, layer planned (the approved revision, the default) | observed (the latest observation), marker one of ${HEALTH_MARKER_KINDS.join(" | ")}`;

const DESIGN_CHANGE_KINDS = ["change", "remove", "rewire"] as const;

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

/** An observed layer may be larger than its design: code the design does not hold is drawn too. */
export const OBSERVATION_LIMITS = {
	steps: 200,
	edges: 600,
	after: 24,
} as const;

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
	"WORKFLOW_OBSERVATION_UNROOTED",
	"WORKFLOW_OBSERVATION_REVISION_NOT_APPROVED",
	"WORKFLOW_OBSERVATION_COMMIT_OFF_BRANCH",
	"WORKFLOW_OBSERVATION_CITATION_MISSING",
	"WORKFLOW_OBSERVATION_SOURCE_UNREADABLE",
	...PERMISSION_REFUSAL_CODES,
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

/** The rewrite threshold (REQ-17 BC-25), a project setting: `workflows.rewriteThreshold`. */
export const REWRITE_THRESHOLD_DEFAULTS = {
	aspects: 2,
	markers: 3,
	problemIssues: 2,
	problemWindowDays: 30,
} as const;
export type RewriteThresholdKey = keyof typeof REWRITE_THRESHOLD_DEFAULTS;

export const rewriteThresholdSchema = z.strictObject({
	aspects: z.number().int().min(1).max(3).optional(),
	markers: z.number().int().min(1).max(50).optional(),
	problemIssues: z.number().int().min(1).max(50).optional(),
	problemWindowDays: z.number().int().min(1).max(365).optional(),
});
export type RewriteThresholdSetting = z.infer<typeof rewriteThresholdSchema>;

export interface RewriteThresholdView {
	aspects: number;
	markers: number;
	problemIssues: number;
	problemWindowDays: number;
	/** Which values are the default because the project sets none. */
	defaults: Record<RewriteThresholdKey, boolean>;
}

export function rewriteThresholdOf(
	set: RewriteThresholdSetting | undefined,
): RewriteThresholdView {
	const keys = Object.keys(REWRITE_THRESHOLD_DEFAULTS) as RewriteThresholdKey[];
	const value = (k: RewriteThresholdKey) =>
		set?.[k] ?? REWRITE_THRESHOLD_DEFAULTS[k];
	return {
		aspects: value("aspects"),
		markers: value("markers"),
		problemIssues: value("problemIssues"),
		problemWindowDays: value("problemWindowDays"),
		defaults: Object.fromEntries(
			keys.map((k) => [k, set?.[k] === undefined]),
		) as Record<RewriteThresholdKey, boolean>,
	};
}

export const HEALTH_MARKER_RULES = [
	"outdated.criterion_reworded",
	"outdated.contract_breaking",
	"outdated.built_behind",
	"outdated.drift",
	"needs_update.feedback_open",
	"needs_update.suggestion_accepted",
	"needs_update.revision_changes",
	"has_problem.verdict_fail",
	"has_problem.reopened",
	"has_problem.run_stuck",
	"has_problem.run_failed",
	"remove_proposed.revision",
	"remove_proposed.suggestion",
	"provenance.planned_only",
	"provenance.observed_only",
	"provenance.diverged",
] as const;
export type HealthMarkerRule = (typeof HEALTH_MARKER_RULES)[number];

export const MARKER_ASPECTS = ["behaviour", "data", "wiring"] as const;
export type MarkerAspect = (typeof MARKER_ASPECTS)[number];

export const MARKER_SOURCE_TYPES = [
	"requirement_criterion",
	"contract_version",
	"criterion_verdict",
	"workflow_observation",
	"feedback",
	"suggestion",
	"design_revision",
	"issue",
	"run",
] as const;
export type MarkerSourceType = (typeof MARKER_SOURCE_TYPES)[number];

/** The record a marker is read from: its type, its key (REQ-4 BC-7, FB-12, ISS-89, r3, a sha) and where it opens. */
export interface MarkerSource {
	type: MarkerSourceType;
	key: string;
	href: string | null;
}

/** What a marker is on: a step or an edge of one layer, or the workflow when its source names no step. */
export type HealthTarget =
	| { kind: "step"; step: string; layer: NodeLayer }
	| {
			kind: "edge";
			from: string;
			to: string;
			label: string | null;
			layer: NodeLayer;
	  }
	| { kind: "workflow" };

export interface HealthMarker {
	kind: HealthMarkerKind;
	target: HealthTarget;
	rule: HealthMarkerRule;
	/** One sentence. */
	reason: string;
	source: MarkerSource;
	/** Whose turn the source is, from the source's own read model; the marker adds no turn. */
	waitingOn: WaitingOn;
	since: string | null;
	/** `wrong` only: the aspects that differ. */
	aspects?: MarkerAspect[];
}

export type HealthCounts = Record<HealthMarkerKind, number>;

export const NODE_PROVENANCES = ["planned", "observed", "matched"] as const;
export type NodeProvenance = (typeof NODE_PROVENANCES)[number];

export const NODE_REWRITE_READINGS = [
	"due",
	"decided_rewrite",
	"decided_keep",
	"decided_delete",
	"none",
] as const;
export type NodeRewriteReading = (typeof NODE_REWRITE_READINGS)[number];

export const REWRITE_RULES = [
	"rewrite.divergence",
	"rewrite.marker_count",
	"rewrite.repeat_problem",
] as const;
export type RewriteRule = (typeof REWRITE_RULES)[number];

export const NODE_PHASES = [
	"marked",
	"decided",
	"cleaning",
	"reconciled",
] as const;
export type NodePhase = (typeof NODE_PHASES)[number];

export interface HealthNodeDecision {
	verdict: NodeDecisionVerdict;
	reason: string;
	marker: HealthMarkerKind | null;
	commentId: string;
	by: string | null;
	byName: string | null;
	at: string;
}

export interface HealthNode {
	target: Exclude<HealthTarget, { kind: "workflow" }>;
	provenance: NodeProvenance;
	/** The kinds the node carries, one dot each, in `HEALTH_MARKER_KINDS` order. */
	kinds: HealthMarkerKind[];
	rewrite: NodeRewriteReading;
	/** Which threshold was crossed; null when none was. */
	rewriteRule: RewriteRule | null;
	/** The decision the threshold or the marker proposes (design-reconciliation `threshold`); null where none is proposed. */
	proposedDecision: NodeDecisionVerdict | null;
	/** Null for a node that carries no marker and was never decided. */
	phase: NodePhase | null;
	decision: HealthNodeDecision | null;
}

export const ORPHAN_RECORD_TYPES = [
	"requirement_criterion",
	"feedback",
	"suggestion",
	"build",
] as const;
export type OrphanRecordType = (typeof ORPHAN_RECORD_TYPES)[number];

/** A trace a proposed revision would leave pointing at nothing, listed for its approver. */
export interface OrphanedTrace {
	target: Exclude<HealthTarget, { kind: "workflow" }>;
	recordType: OrphanRecordType;
	key: string;
	href: string | null;
}

export const DIFF_MARKS = ["added", "changed", "removed"] as const;
export type DiffMark = (typeof DIFF_MARKS)[number];

/** The proposed revision against the approved one, as core derives it (`bkm-diff`); edges keyed `from>to`. */
export interface DesignDiffView {
	from: number;
	to: number;
	steps: Record<string, DiffMark>;
	edges: Record<string, DiffMark>;
}

export const ROOT_GAPS = ["approved_revision", "requirement"] as const;
export type RootGap = (typeof ROOT_GAPS)[number];

/** Whether a design may be observed (design-reconciliation `rooted`). */
export interface WorkflowRootedView {
	rooted: boolean;
	approvedRevision: number | null;
	/** REQ keys of the requirements linked to the design. */
	requirements: string[];
	missing: RootGap[];
}

export interface HealthObservedStep {
	id: string;
	matches: string | null;
	title: string | null;
	does: string;
	after: string[];
}

export interface HealthObservedEdge {
	from: string;
	to: string;
	label: string | null;
}

export const RECONCILIATION_STATES = ["reconciled", "open"] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

/**
 * Whether a design is reconciled with its code (design-reconciliation `release`, `reconciled-view`):
 * the dev version that shipped its reconciliation builds is out, and no node carries a provenance
 * marker without a recorded decision. Derived on read; nothing writes it.
 */
export interface WorkflowReconciliation {
	state: ReconciliationState;
	/** Nodes carrying an Upcoming, Not in design or Wrong marker that no decision names. */
	undecided: number;
	/** Decided nodes whose build issue, linked after the decision, is still open. */
	cleaning: number;
	/** The build issues linked after a node decision, by key. */
	issues: string[];
	/** The newest release that carried those issues; null while any of them is unreleased, or none exists. */
	version: { version: string; releasedAt: string | null } | null;
	/** Business criteria tracing this design, and how many of them the latest verdict passed. */
	criteria: { total: number; proven: number };
	/** Why the state is what it is, in a sentence. */
	rule: string;
}

/** A revision proposed and not yet decided: what Needs you reads to put the approval on the design itself. */
export interface WorkflowProposal {
	revision: number;
	/** The design's own title as the proposed revision words it. */
	title: string;
	proposedAt: string;
	waitingOn: WaitingOn;
}

/** `GET /api/projects/:id/workflows/:workflow/health`: every marker, node reading and count of one design. */
export interface WorkflowHealth {
	workflowId: string;
	flow: string;
	/** The revision the markers are placed on: the proposed one where one is proposed, else the approved one, else the latest. */
	revision: number;
	approvedRevision: number | null;
	proposedRevision: number | null;
	/** The revision waiting on its approver, with whose turn it is; null where none is proposed. */
	proposal: WorkflowProposal | null;
	rooted: WorkflowRootedView;
	/** The observation the provenance is read from; null when the code has not been observed. */
	observation: {
		id: string;
		atSha: string;
		revision: number;
		createdAt: string;
		writtenBy: string;
		writtenByAgency: "human" | "agent";
	} | null;
	markers: HealthMarker[];
	counts: HealthCounts;
	nodes: HealthNode[];
	/** Markers whose source names no step. */
	workflowLevel: HealthMarker[];
	/** Sources waiting on a person, plus undecided Rewrite-due and Not in design nodes. */
	needsYou: number;
	orphanedTraces: OrphanedTrace[];
	diff: DesignDiffView | null;
	/** The observed layer, for the canvas: every observed step and edge, matched or not. */
	observed: { steps: HealthObservedStep[]; edges: HealthObservedEdge[] } | null;
	threshold: RewriteThresholdView;
	reconciliation: WorkflowReconciliation;
}

/** `WorkflowSummaryView.health`: what the workflows list and Needs you read, from the same read model. */
export interface WorkflowHealthSummary {
	counts: HealthCounts;
	needsYou: number;
	/** True when every marker is workflow-level: its records name no step yet. */
	workflowLevelOnly: boolean;
	observed: boolean;
	reconciled: boolean;
}

export const emptyHealthCounts = (): HealthCounts =>
	Object.fromEntries(HEALTH_MARKER_KINDS.map((k) => [k, 0])) as HealthCounts;
