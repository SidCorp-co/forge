import type { DesignRevisionState } from "./design-status.js";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";

// cm:why the answer shapes a workflow and its design are read in when the whole document is not
// asked for (ISS-87)

export const WORKFLOW_SUMMARY_FIELDS = [
	"workflowId",
	"flow",
	"title",
	"kind",
	"template",
	"status",
	"revision",
	"approvedRevision",
	"stepCount",
	"edgeCount",
	"returnReason",
	"writerName",
	"updatedAt",
] as const;

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
}

export const WORKFLOW_WRITE_FIELDS = [
	"workflowId",
	"flow",
	"revision",
	"created",
	"status",
	"approvedRevision",
	"stepCount",
	"edgeCount",
	"updatedAt",
] as const;

export type WorkflowWriteAnswer = Pick<
	WorkflowSummaryView,
	| "workflowId"
	| "flow"
	| "revision"
	| "status"
	| "approvedRevision"
	| "stepCount"
	| "edgeCount"
	| "updatedAt"
> & { created: boolean };

export const DESIGN_VIEWS = ["summary", "steps", "full"] as const;
export type DesignViewName = (typeof DESIGN_VIEWS)[number];

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

export interface DesignHead {
	workflowId: string;
	flow: string;
	status: string | null;
	revision: number;
	proposedRevision: number | null;
	approvedRevision: number | null;
	approver: string;
	canDecide: boolean;
	waitingOn: DesignWaitingOn;
}

export const DESIGN_WAITING_ON_KINDS = [
	"you",
	"person",
	"agent",
	"none",
] as const;
export type DesignWaitingOnKind = (typeof DESIGN_WAITING_ON_KINDS)[number];

// cm:why whose turn a design is, worded as a requirement's is (`requirements.ts:RequirementWaitingOn`), so every screen says it once from core (`workflows/design-standing.ts:designStandingOf`)
export interface DesignWaitingOn {
	kind: DesignWaitingOnKind;
	who: string;
	act: string;
	rule: string;
}

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

export const DESIGN_ACTS = ["propose", "decide", "link", "unlink"] as const;
export type DesignAct = (typeof DESIGN_ACTS)[number];

export interface DesignActAnswer extends DesignHead {
	act: DesignAct;
	acted?: DesignRevisionSummary;
	builds?: DesignBuild[];
	designIssue?: unknown;
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
	"WORKFLOW_BUILD_NOT_LINKED",
	"WORKFLOW_NODE_UNKNOWN",
	"WORKFLOW_NODE_AMBIGUOUS",
	...PERMISSION_REFUSAL_CODES,
] as const;
export type DesignRefusalCode = (typeof DESIGN_REFUSAL_CODES)[number];

/** A traced design, requirement or pinned contract a job cannot be given; the job is refused by name. */
export const ARTIFACT_CONTEXT_REFUSAL_CODES = [
	"ARTIFACT_CONTEXT_UNLOADABLE",
	"ARTIFACT_CONTEXT_OVER_BUDGET",
	"REQUIREMENT_REVISION_NOT_CURRENT",
	"REQUIREMENT_NOT_AGREED",
] as const;
export type ArtifactContextRefusalCode =
	(typeof ARTIFACT_CONTEXT_REFUSAL_CODES)[number];
