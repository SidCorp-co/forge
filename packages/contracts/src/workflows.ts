import type { DesignRevisionState } from "./design-status.js";
import type { WaitingKind, WaitingOn } from "./standing.js";

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

export const DESIGN_ACTS = ["propose", "decide", "link", "unlink"] as const;
export type DesignAct = (typeof DESIGN_ACTS)[number];

export interface DesignActAnswer extends DesignHead {
	act: DesignAct;
	acted?: DesignRevisionSummary;
	builds?: DesignBuild[];
	designIssue?: unknown;
}
