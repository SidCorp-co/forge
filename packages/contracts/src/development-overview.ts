// the Development overview's one read model (`GET /api/projects/:id/development/overview`):

import type {
	IssueAttentionGroup,
	IssueLeaseVerdict,
	IssueWaitingKind,
} from "./issue-standing.js";
import type { IssueStatus } from "./issue-machine.js";
import type { IssueStatusTone, WorkStep } from "./issue-vocabulary.js";
import type { MasterSlots, MasterState } from "./master-standing.js";
import type { Said } from "./said.js";
import type { WaitingOn } from "./standing.js";

export const OVERVIEW_WINDOW_DAYS = 14;

interface OverviewUnavailable {
	available: false;
	reason: string;
	/** `reason` as said (`said.ts`). */
	says: { reason: Said };
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
	state: MasterState;
	slots: MasterSlots | null;
	slotsNote: string | null;
	/** `slotsNote` as said (`said.ts`); a box's own refusal detail is carried as written. */
	says: { slotsNote: Said | null };
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
type OverviewFlowStageId = (typeof OVERVIEW_FLOW_STAGES)[number];

export const OVERVIEW_FLOW_STAGE_OF: Record<
	IssueStatus,
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
	status: IssueStatus;
	step: WorkStep | null;
	holder: string | null;
	box: string | null;
	branch: string | null;
	segments: OverviewLaneSegment[];
	heldSince: string | null;
	lease: { verdict: IssueLeaseVerdict; expiresAt: string | null } | null;
	waitingOn: WaitingOn<IssueWaitingKind>;
}

export interface OverviewMoving {
	count: number;
	window: { from: string; to: string; now: string } | null;
	lanes: OverviewLane[];
}

export interface OverviewChainNode {
	kind: "issue";
	key: string;
	title: string;
	status: IssueStatus | null;
	step: WorkStep | null;
	tone: IssueStatusTone | null;
	waitingOn: WaitingOn<IssueWaitingKind> | null;
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

/**
 * What holds work back that is not a person's ordinary turn (REQ-74 BC-4, BC-5): a release hold on an
 * issue at the gate, a held job, a run behind a gate it cannot clear by moving, a run that failed and
 * whose issue nothing has taken up again, and a live run nothing moves. Each names its cause and who
 * acts on it next.
 */
export const OVERVIEW_HOLD_KINDS = [
	"release",
	"job",
	"blocked",
	"failed",
	"stuck",
] as const;
export type OverviewHoldKind = (typeof OVERVIEW_HOLD_KINDS)[number];

export interface OverviewHold {
	kind: OverviewHoldKind;
	/** The run held; null for an issue a release holds at the gate with no run of its own. */
	runId: string | null;
	/** The issues it holds, by key. */
	issues: string[];
	/** The release it sits in: a release run's version, or the drafted one for a hold at the gate. */
	release: string | null;
	/** Why it is held, in one sentence. */
	cause: string;
	/** Who acts on it next and what they do; `who` is never empty. */
	waitingOn: WaitingOn;
	since: string | null;
	/** `cause` as said (`said.ts`). */
	says: { cause: Said };
}

/** The holds on one issue or one release, its key an issue's `ISS-n` or a release's version. */
export interface OverviewHoldGroup {
	key: string;
	title: string;
	holds: OverviewHold[];
}

export interface OverviewHolds {
	count: number;
	issues: OverviewHoldGroup[];
	releases: OverviewHoldGroup[];
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

export interface DevelopmentOverview {
	generatedAt: string;
	signals: OverviewSignals;
	flow: OverviewFlow;
	moving: OverviewMoving;
	stuck: OverviewStuck;
	holds: OverviewHolds;
	modules: OverviewModules;
	coverage: {
		open: number;
		openRead: number;
		limit: number;
		flowTruncated: boolean;
	};
}
