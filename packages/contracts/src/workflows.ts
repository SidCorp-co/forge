import type { DesignRevisionState, DesignStatus } from "./design-status.js";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";
import type { RefusalStatuses } from "./refusal.js";
import type { WaitingKind, WaitingOn } from "./standing.js";
import type { WorkflowHealthSummary } from "./workflow-health.js";

export interface WorkflowSummaryView {
	workflowId: string;
	flow: string;
	title: string;
	kind: string | null;
	template: { id: string; version: number } | null;
	status: string | null;
	revision: number;
	approvedRevision: number | null;
	stepCount: number;
	edgeCount: number;
	returnReason: string | null;
	writerName: string;
	updatedAt: string;
	/** The design's health counts and needs-you figure (workflow-step-health `d-list-summary`). */
	health: WorkflowHealthSummary;
}

export const DESIGN_VIEWS = ["summary", "steps", "full"] as const;

export const DESIGN_HEAD_FIELDS = [
	"workflowId",
	"flow",
	"status",
	"revision",
	"proposedRevision",
	"approvedRevision",
	"approver",
	"canDecide",
	"waitingOn",
] as const;

interface DesignHead {
	workflowId: string;
	flow: string;
	status: string | null;
	revision: number;
	proposedRevision: number | null;
	approvedRevision: number | null;
	approver: string;
	canDecide: boolean;
	waitingOn: WaitingOn<DesignWaitingKind>;
}

/** How the workflows list reads one design: the status it shows and a newer revision waiting on its approver. */
export interface DesignListReading {
	shown: DesignStatus | null;
	pendingRevision: number | null;
	waitingOn: WaitingOn<DesignWaitingKind>;
}

export const DESIGN_WAITING_KINDS = [
	"you",
	"person",
	"agent",
	"none",
] as const satisfies readonly WaitingKind[];
export type DesignWaitingKind = (typeof DESIGN_WAITING_KINDS)[number];

export interface DesignRequirementLink {
	key: string;
	title: string;
	status: string;
	pinnedRevision: number | null;
}

export interface DesignBuildGate {
	open: boolean;
	rule: string;
}

export interface DesignRevisionSummary {
	revision: number;
	designIssueId: string | null;
	proposedBy: string | null;
	proposedByName: string | null;
	proposedAt: string;
	decision: string | null;
	decidedBy: string | null;
	decidedByName: string | null;
	decidedAt: string | null;
	reason: string | null;
	state: DesignRevisionState;
	stepCount: number;
}

export interface DesignBuild {
	issueId: string;
	displayId: string;
	title: string;
	status: string;
}

export interface DesignSummaryView extends DesignHead {
	revisions: DesignRevisionSummary[];
	builds: DesignBuild[];
}

export interface DesignStepsView extends DesignSummaryView {
	document: {
		revision: number;
		stepCount: number;
		edgeCount: number;
		from: number;
		to: number;
		steps: unknown[];
		edges: unknown[];
	};
}

export const WORKFLOW_REFUSAL_CODES = [
	"WORKFLOW_KIND_UNKNOWN",
	"WORKFLOW_STEP_DUPLICATE",
	"WORKFLOW_AFTER_DANGLING",
	"WORKFLOW_AFTER_CYCLE",
	"WORKFLOW_EDGE_DANGLING",
	"WORKFLOW_EDGE_UNDRAWN",
	"WORKFLOW_EDGE_DUPLICATE",
	"WORKFLOW_EDGE_RETURN_FORWARD",
	"WORKFLOW_EDGE_REEVALUATES_FORWARD",
	"WORKFLOW_EDGE_FIELD_MISSING",
	"WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE",
	"WORKFLOW_TEMPLATE_MISSING",
	"WORKFLOW_TEMPLATE_UNKNOWN",
	"WORKFLOW_DESIGN_ISSUE_IS_BUILD",
	"WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE",
	"WORKFLOW_NODE_FIELD_MISSING",
	"WORKFLOW_BAND_MISMATCH",
	"WORKFLOW_TEMPLATE_RULE",
	"WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND",
	"WORKFLOW_EDGE_KIND_NONE",
	"WORKFLOW_EDGE_KIND_AMBIGUOUS",
	"WORKFLOW_NODE_NOT_ENTRY",
	"WORKFLOW_NODE_TYPE_COUNT",
	"WORKFLOW_NODE_LINES",
	"WORKFLOW_NODE_FIELD_NOT_UNIQUE",
	"WORKFLOW_NODE_VALUE_NOT_IN_VOCABULARY",
	"WORKFLOW_REF_NOT_ALLOWED",
	"WORKFLOW_REF_DANGLING",
	"WORKFLOW_REF_TARGET_MISMATCH",
	"WORKFLOW_REF_MISSING",
	"WORKFLOW_BASE_SELF",
	"WORKFLOW_BASE_DUPLICATE",
	"WORKFLOW_BASE_UNKNOWN",
	"WORKFLOW_DUPLICATE",
	"WORKFLOW_IDENTITY_IMMUTABLE",
	"REQUIREMENT_BINDING_NOT_INDEXED",
	"PATH_OUTSIDE_REPO",
	"PROJECT_ID_IMMUTABLE",
] as const;
export type WorkflowRefusalCode = (typeof WORKFLOW_REFUSAL_CODES)[number];

export const DESIGN_REFUSAL_CODES = [
	"WORKFLOW_DESIGN_NOT_PROPOSED",
	"WORKFLOW_DESIGN_REVISION_STALE",
	"WORKFLOW_DESIGN_REASON_MISSING",
	"WORKFLOW_DESIGN_ALREADY_PROPOSED",
	"WORKFLOW_DESIGN_ALREADY_APPROVED",
	"WORKFLOW_DESIGN_UNCHANGED",
	"WORKFLOW_DESIGN_NOT_APPROVED",
	"WORKFLOW_DESIGN_BASE_UNAPPROVED",
	"WORKFLOW_DESIGN_ISSUE_IS_BUILD",
	"WORKFLOW_BUILD_ALREADY_LINKED",
	"WORKFLOW_NODE_UNKNOWN",
	"WORKFLOW_NODE_AMBIGUOUS",
	...PERMISSION_REFUSAL_CODES,
] as const;
export type DesignRefusalCode = (typeof DESIGN_REFUSAL_CODES)[number];
export const DESIGN_REFUSAL_STATUSES = {
	WORKFLOW_DESIGN_REVISION_STALE: 409,
} as const satisfies RefusalStatuses<DesignRefusalCode>;

/** A traced design, requirement or pinned contract a job cannot be given; the job is refused by name. */
export const ARTIFACT_CONTEXT_REFUSAL_CODES = [
	"ARTIFACT_CONTEXT_UNLOADABLE",
	"ARTIFACT_CONTEXT_OVER_BUDGET",
	"REQUIREMENT_REVISION_NOT_CURRENT",
	"REQUIREMENT_NOT_AGREED",
] as const;
export type ArtifactContextRefusalCode =
	(typeof ARTIFACT_CONTEXT_REFUSAL_CODES)[number];
