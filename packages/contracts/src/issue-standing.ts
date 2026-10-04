import type {
	IssueStatusTone,
	KernelIssueStatus,
	WorkStep,
} from "./issue-vocabulary.js";

/** The list's attention groups, in the order they are drawn. */
export const ISSUE_ATTENTION_GROUPS = [
	"needs_you",
	"moving",
	"stuck",
	"queued",
	"paused",
	"done",
] as const;
export type IssueAttentionGroup = (typeof ISSUE_ATTENTION_GROUPS)[number];

export const ISSUE_ATTENTION_LABELS: Record<
	IssueAttentionGroup,
	{ label: string; hint: string; tone: IssueStatusTone; collapsed: boolean }
> = {
	needs_you: {
		label: "Needs you",
		hint: "Answer, decide or approve",
		tone: "you",
		collapsed: false,
	},
	moving: {
		label: "Moving",
		hint: "A run holds a live lease",
		tone: "run",
		collapsed: false,
	},
	stuck: {
		label: "Stuck",
		hint: "Waits on another issue, has no live holder, or came back",
		tone: "blocked",
		collapsed: false,
	},
	queued: {
		label: "Queued",
		hint: "Nothing blocks it; waits for a master slot, a judge or a release",
		tone: "ready",
		collapsed: false,
	},
	paused: {
		label: "Paused",
		hint: "Deliberately on hold",
		tone: "neutral",
		collapsed: true,
	},
	done: {
		label: "Done",
		hint: "Shipped or dropped",
		tone: "done",
		collapsed: true,
	},
};

/** Whom an issue waits on: the viewer, another person, a run that holds it, the master that takes
 *  it next, the judge of a change that landed, another issue that blocks it, the release, or nobody. */
export const ISSUE_WAITING_KINDS = [
	"you",
	"person",
	"run",
	"master",
	"judge",
	"issue",
	"release",
	"none",
] as const;
export type IssueWaitingKind = (typeof ISSUE_WAITING_KINDS)[number];

export interface IssueWaitingOn {
	kind: IssueWaitingKind;
	/** Sentence-case name: "You", "Run", "Master", "Judge", "ISS-12", "A project writer", "Nobody". */
	who: string;
	/** What they owe, lower-case after the name: "answer a question", "Test · 12 min", "running". */
	act: string;
	/** Why, for the tooltip: the rule in `issues/standing.ts` that put it there. */
	rule: string;
	/** The issue key `who` names when `kind` is `issue`; else null. */
	ref: string | null;
}

/** An edge that holds this issue back, or one this issue holds back: live `blocks` edges only. */
export interface IssueEdgeRef {
	key: string;
	title: string;
	status: KernelIssueStatus;
	/** The other issue's own attention group, so a chip can say "needs you" or "running". */
	group: IssueAttentionGroup | null;
	landed: boolean;
}

export interface IssueCriteriaTally {
	total: number;
	/** Latest verdict `pass` or `short`. */
	passing: number;
	failing: number;
	/** Latest verdict `skipped`: judged, never earns. */
	skipped: number;
}

export interface IssueRequirementRef {
	key: string;
	title: string;
	/** The business criteria the issue's criteria trace to, e.g. ["BC-3"]. */
	criteria: string[];
	plannedRevision: number | null;
	currentRevision: number | null;
	/** Planned on an older revision than the requirement's current one. */
	changedSincePlan: boolean;
}

export interface IssueModuleRef {
	id: string;
	/** The module's slug path from its root, e.g. "storefront/autoflow". */
	path: string;
	name: string;
}

/** `issue_work_state.lease` as `classifyLease` reads it; `live` and `shared` hold the issue. */
export const ISSUE_LEASE_VERDICTS = [
	"live",
	"shared",
	"expired",
	"abandoned",
	"malformed",
] as const;
export type IssueLeaseVerdict = (typeof ISSUE_LEASE_VERDICTS)[number];

/** A lease as a person reads it: live and shared hold the issue; the rest no longer do. */
export const ISSUE_LEASE_VERDICT_LABELS: Record<IssueLeaseVerdict, string> = {
	live: "Live",
	shared: "Shared",
	expired: "Expired",
	abandoned: "Abandoned",
	malformed: "Unreadable",
};

export const ISSUE_LEASE_VERDICT_TONES: Record<
	IssueLeaseVerdict,
	IssueStatusTone
> = {
	live: "run",
	shared: "run",
	expired: "blocked",
	abandoned: "blocked",
	malformed: "err",
};

export interface IssueLeaseView {
	holder: string | null;
	verdict: IssueLeaseVerdict;
	expiresAt: string | null;
}

export interface IssueStepEntry {
	step: WorkStep;
	startedAt: string;
	endedAt: string | null;
}

export interface IssueStanding {
	state: KernelIssueStatus;
	/** The run's step inside the status (`issue_work_state.step`), null where none is recorded. */
	step: WorkStep | null;
	stepStartedAt: string | null;
	/** The status badge's tone for this project: `awaiting_release` reads `you` only where the
	 *  project requires a person to approve a release. */
	tone: IssueStatusTone;
	attentionGroup: IssueAttentionGroup;
	waitingOn: IssueWaitingOn;
	criteria: IssueCriteriaTally;
	requirement: IssueRequirementRef | null;
	module: IssueModuleRef | null;
	/** Product feedback (FB-n) routed to this issue. */
	feedback: string[];
	blockedBy: IssueEdgeRef[];
	blocks: IssueEdgeRef[];
	lease: IssueLeaseView | null;
	/** A job or run is queued or running on it (the dispatcher's in-flight reading). */
	inFlight: boolean;
	branch: string | null;
	headSha: string | null;
	owner: { id: string; name: string | null; kind: "human" | "agent" } | null;
	/** Topological layer over open `blocks` edges: 0 has no open blocker; null on a cycle or once done. */
	wave: number | null;
	/** The newest write to the issue, its work state or its activity. */
	touchedAt: string;
}

/** One issue as the list reads it; the derived facts are the server's, never the client's. */
export interface IssueStandingRow {
	id: string;
	key: string;
	title: string;
	status: KernelIssueStatus;
	priority: string;
	category: string | null;
	complexity: string | null;
	assigneeId: string | null;
	createdById: string | null;
	createdAt: string;
	updatedAt: string;
	standing: IssueStanding;
}

export const ISSUE_STANDING_SCOPES = ["open", "closed", "all"] as const;
export type IssueStandingScope = (typeof ISSUE_STANDING_SCOPES)[number];

export interface IssueStandingList {
	issues: IssueStandingRow[];
	/** Rows in each scope, so the scope switch can count without a second read. */
	counts: Record<IssueStandingScope, number> & {
		needsYou: number;
		blocked: number;
		blocking: number;
	};
	/** Rows answered; below the scope's count when the read hit its limit. */
	returned: number;
	limit: number;
	releaseApproval: boolean;
}

export interface IssueStandingDetail extends IssueStandingRow {
	/** The run's step log, oldest first. */
	steps: IssueStepEntry[];
	releaseApproval: boolean;
}
