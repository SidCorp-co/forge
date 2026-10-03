// cm:why the Development overview's one read model (`GET /api/projects/:id/development/overview`):

import type {
	IssueAttentionGroup,
	IssueLeaseVerdict,
	IssueWaitingOn,
} from "./issue-standing.js";
import type {
	IssueStatusTone,
	KernelIssueStatus,
	WorkStep,
} from "./issue-vocabulary.js";

export const OVERVIEW_WINDOW_DAYS = 14;

export interface OverviewUnavailable {
	available: false;
	reason: string;
}

export interface OverviewContractWindow {
	contract: string;
	version: string;
	dueAt: string;
	feedback: string;
}

export interface OverviewContractsSignal {
	windows: OverviewContractWindow[];
	openWindows: number;
	awaitingApproval: number;
}

export const OVERVIEW_WINDOWS_SHOWN = 3;

export interface OverviewMasterSignal {
	masters: number;
	runs: number;
	capacity: number | null;
	capacityNote: string;
}

export interface OverviewSignals {
	ci: OverviewUnavailable;
	postMerge: OverviewUnavailable;
	contracts: OverviewContractsSignal;
	master: OverviewMasterSignal;
}

export const OVERVIEW_FLOW_STAGES = [
	"draft",
	"open",
	"in_progress",
	"awaiting_release",
	"closed",
] as const;
export type OverviewFlowStageId = (typeof OVERVIEW_FLOW_STAGES)[number];

export const OVERVIEW_FLOW_LABELS: Record<OverviewFlowStageId, string> = {
	draft: "Draft",
	open: "Open",
	in_progress: "In progress",
	awaiting_release: "Awaiting release",
	closed: "Closed",
};

export const OVERVIEW_FLOW_STAGE_OF: Record<
	KernelIssueStatus,
	OverviewFlowStageId
> = {
	draft: "draft",
	open: "open",
	approved: "open",
	needs_info: "open",
	on_hold: "open",
	reopen: "open",
	in_progress: "in_progress",
	awaiting_release: "awaiting_release",
	closed: "closed",
	dropped: "closed",
};

export interface OverviewAttentionPart {
	group: IssueAttentionGroup;
	count: number;
}

export interface OverviewFlowStage {
	id: OverviewFlowStageId;
	count: number;
	parts: OverviewAttentionPart[];
}

export interface OverviewFlow {
	windowDays: number;
	total: number;
	stages: OverviewFlowStage[];
}

export interface OverviewLaneSegment {
	step: WorkStep;
	startedAt: string;
	endedAt: string | null;
}

export interface OverviewLane {
	key: string;
	title: string;
	status: KernelIssueStatus;
	step: WorkStep | null;
	holder: string | null;
	box: string | null;
	branch: string | null;
	segments: OverviewLaneSegment[];
	heldSince: string | null;
	lease: { verdict: IssueLeaseVerdict; expiresAt: string | null } | null;
	waitingOn: IssueWaitingOn;
}

export interface OverviewMoving {
	count: number;
	window: { from: string; to: string; now: string } | null;
	lanes: OverviewLane[];
}

export interface OverviewChainNode {
	kind: "issue" | "contract";
	key: string;
	title: string;
	status: KernelIssueStatus | null;
	step: WorkStep | null;
	tone: IssueStatusTone | null;
	waitingOn: IssueWaitingOn | null;
	held: boolean;
}

export interface OverviewChain {
	id: string;
	levels: OverviewChainNode[][];
	held: number;
}

export interface OverviewStuck {
	count: number;
	chains: OverviewChain[];
}

export interface OverviewModuleRow {
	id: string | null;
	path: string;
	name: string;
	open: number;
	parts: OverviewAttentionPart[];
	shipped: number;
	lastLandingAt: string | null;
}

export interface OverviewModules {
	rows: OverviewModuleRow[];
	max: number;
	unassigned: OverviewModuleRow;
}

export const OVERVIEW_NEED_KINDS = ["issue", "release", "contract"] as const;
export type OverviewNeedKind = (typeof OVERVIEW_NEED_KINDS)[number];

export type OverviewNeedState =
	| {
			family: "issue";
			value: KernelIssueStatus;
			step: WorkStep | null;
			tone: IssueStatusTone;
	  }
	| { family: "release"; value: "pending" }
	| { family: "classification"; value: string };

export interface OverviewNeed {
	kind: OverviewNeedKind;
	key: string;
	ref: string;
	title: string;
	facts: string[];
	state: OverviewNeedState;
	waitingOn: IssueWaitingOn;
	owner: { name: string | null; kind: "human" | "agent" } | null;
	touchedAt: string | null;
}

export interface OverviewNeeds {
	count: number;
	rows: OverviewNeed[];
}

export interface DevelopmentOverview {
	generatedAt: string;
	signals: OverviewSignals;
	flow: OverviewFlow;
	moving: OverviewMoving;
	stuck: OverviewStuck;
	modules: OverviewModules;
	needsYou: OverviewNeeds;
	coverage: {
		open: number;
		openRead: number;
		limit: number;
		flowTruncated: boolean;
	};
}
