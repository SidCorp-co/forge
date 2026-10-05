// Where a requirement stands — the read model core derives in `requirements/standing.ts` and every
// requirement surface draws: the attention group it is listed under, whom it waits on, the facts that
// decide it, and the coverage of each business criterion. Core writes the shapes; web-v2 reads the
// labels, so one value keeps one badge on every screen.

import { z } from "zod";
import type {
	FeedbackKind,
	FeedbackPhase,
	FeedbackRouteView,
	FeedbackSeverity,
} from "./feedback.js";
import type { IssueStatusTone } from "./issue-vocabulary.js";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";
import type { RefusalStatuses } from "./refusal.js";
import type {
	Standing,
	StandingGroup,
	StandingGroupLabels,
	WaitingKind,
	WaitingOn,
} from "./standing.js";
import type { CriterionTraceView } from "./workflow-health.js";

export const REQUIREMENT_STATUSES = [
	"draft",
	"agreed",
	"accepted",
	"dropped",
	"deferred",
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const DEFERRABLE_STATUSES = ["draft", "agreed"] as const;

export const REQUIREMENT_DEFERRAL_ACTS = ["defer", "undefer"] as const;

export const BASELINE_ACTS = ["agree", "repin"] as const;

/** The lifecycle a person reads: the stored status (draft, agreed, accepted, dropped) with agreed
 *  split by the derived delivery phase. `dropped` and `deferred` are off the line. */
export const REQUIREMENT_LIFECYCLE = [
	"draft",
	"agreed",
	"in_delivery",
	"delivered",
	"accepted",
] as const;
export const REQUIREMENT_STATES = [
	...REQUIREMENT_LIFECYCLE,
	"deferred",
	"dropped",
] as const;
export type RequirementState = (typeof REQUIREMENT_STATES)[number];

/** The issue badge legend's tones, so a requirement's colours mean what an issue's do. */
type StandingTone = IssueStatusTone;

export const REQUIREMENT_STATE_LABELS: Record<RequirementState, string> = {
	draft: "Draft",
	agreed: "Agreed",
	in_delivery: "In delivery",
	delivered: "Delivered",
	accepted: "Accepted",
	deferred: "Deferred",
	dropped: "Dropped",
};

export const REQUIREMENT_STATE_TONES: Record<RequirementState, StandingTone> = {
	draft: "neutral",
	agreed: "ready",
	in_delivery: "run",
	delivered: "you",
	accepted: "done",
	deferred: "neutral",
	dropped: "done",
};

export const REQUIREMENT_STATE_GLYPHS: Record<RequirementState, string> = {
	draft: "○",
	agreed: "◆",
	in_delivery: "●",
	delivered: "✓",
	accepted: "✓",
	deferred: "‖",
	dropped: "×",
};

export const REQUIREMENT_STATE_HINTS: Record<RequirementState, string> = {
	draft: "draft: being written, not agreed; nothing is built against it",
	agreed: "agreed: a person agreed a revision; no linked issue has started",
	in_delivery: "in_delivery: a linked issue has started",
	delivered:
		"delivered: every linked issue is closed; an approver accepts the delivery",
	accepted: "accepted: delivered and accepted",
	deferred:
		"deferred: out of the current release; nothing is planned or built against it until a person undefers it",
	dropped: "dropped: no longer wanted",
};

/** A revision's one state (domain-entities.md "Revisions: one vocabulary"). */
export const REVISION_STATES = [
	"draft",
	"proposed",
	"current",
	"superseded",
] as const;
export type RevisionState = (typeof REVISION_STATES)[number];

export const REVISION_STATE_LABELS: Record<RevisionState, string> = {
	draft: "Draft",
	proposed: "Proposed",
	current: "Current",
	superseded: "Superseded",
};

export const REVISION_STATE_TONES: Record<RevisionState, StandingTone> = {
	draft: "neutral",
	proposed: "you",
	current: "ready",
	superseded: "done",
};

export const REVISION_STATE_GLYPHS: Record<RevisionState, string> = {
	draft: "○",
	proposed: "●",
	current: "✓",
	superseded: "×",
};

export const REVISION_STATE_HINTS: Record<RevisionState, string> = {
	draft: "draft: still being written",
	proposed: "proposed: waiting for a person to accept or return it",
	current: "current: the accepted revision",
	superseded: "superseded: replaced by a later accepted revision",
};

/** The list's attention groups, in the order they are drawn. */
export const REQUIREMENT_ATTENTION_GROUPS = [
	"needs_you",
	"moving",
	"waiting",
	"stuck",
	"deferred",
	"done",
] as const satisfies readonly StandingGroup[];
export type RequirementAttentionGroup =
	(typeof REQUIREMENT_ATTENTION_GROUPS)[number];

export const REQUIREMENT_ATTENTION_LABELS: StandingGroupLabels<RequirementAttentionGroup> =
	{
		needs_you: {
			label: "Needs you",
			hint: "Approve, accept or break down",
			tone: "you",
			collapsed: false,
		},
		moving: {
			label: "Moving",
			hint: "Issues are being worked",
			tone: "run",
			collapsed: false,
		},
		waiting: {
			label: "Someone else’s turn",
			hint: null,
			tone: "neutral",
			collapsed: false,
		},
		stuck: {
			label: "Stuck",
			hint: "No owner, or untouched for weeks",
			tone: "neutral",
			collapsed: false,
		},
		deferred: {
			label: "Deferred",
			hint: "Out of the current release",
			tone: "neutral",
			collapsed: true,
		},
		done: { label: "Done", hint: null, tone: "done", collapsed: true },
	};

/** Whom a requirement waits on: the viewer, another person, an agent (the master, a draft's agent
 *  author), its issues, or nobody (done, or no owner to act). */
export const REQUIREMENT_WAITING_KINDS = [
	"you",
	"person",
	"agent",
	"issue",
	"none",
] as const satisfies readonly WaitingKind[];
export type RequirementWaitingKind = (typeof REQUIREMENT_WAITING_KINDS)[number];

/** The tasks of workflow requirement-to-delivery a requirement holds open, derived on read. */
const REQUIREMENT_TASK_KINDS = ["breakdown", "check"] as const;
export type RequirementTaskKind = (typeof REQUIREMENT_TASK_KINDS)[number];

/** Step `breakdown`: the master proposes the breakdown within this many working days of the agree. */
export const BREAKDOWN_SLA_WORKING_DAYS = 2;
/** Step `check`: the BA checks the business criteria within this many working days of delivery. */
export const CHECK_SLA_WORKING_DAYS = 5;

export interface RequirementTask {
	kind: RequirementTaskKind;
	/** The role the design gives the task: the project master breaks down, the BA checks. */
	owner: "Project master" | "BA";
	/** The requirement revision the task is for; a revision holds at most one of each kind. */
	revision: number;
	openedAt: string;
	dueAt: string;
	overdue: boolean;
}

/** A business criterion's proof: its linked issue criteria and their latest verdicts. */
export const BC_VERDICTS = [
	"passing",
	"failing",
	"stale",
	"not_judged",
	"gap",
] as const;
export type BcVerdict = (typeof BC_VERDICTS)[number];

export const BC_VERDICT_LABELS: Record<BcVerdict, string> = {
	passing: "Passing",
	failing: "Failing",
	stale: "Stale",
	not_judged: "Not judged",
	gap: "Gap",
};

export const BC_VERDICT_TONES: Record<BcVerdict, StandingTone> = {
	passing: "ready",
	failing: "err",
	stale: "neutral",
	not_judged: "neutral",
	gap: "you",
};

export const BC_VERDICT_HINTS: Record<BcVerdict, string> = {
	passing:
		"passing: every issue criterion tracing to this wording has a pass verdict",
	failing:
		"failing: an issue criterion tracing to this wording failed its latest verdict",
	stale:
		"stale: issue criteria trace only to an earlier wording of this criterion",
	not_judged: "not_judged: an issue criterion tracing here has no verdict yet",
	gap: "gap: no issue criterion traces to this criterion",
};

export interface RequirementFacts {
	/** Business criteria of the shown revision whose coverage is passing. */
	passing: number;
	/** Business criteria with a verdict either way (passing or failing). */
	judged: number;
	criteria: number;
	issuesDone: number;
	issuesRunning: number;
	issuesTotal: number;
	/** The open revision waiting on a sign-off, else null. */
	proposedRevision: number | null;
	/** The open revision still being written, else null. */
	draftRevision: number | null;
	/** Linked designs the latest baseline leaves unpinned (pinned null) or pins below their approved revision. */
	stalePins: { flow: string; pinned: number | null; approved: number }[];
	/** Linked contracts whose current version is not the one the latest baseline pins. */
	staleContractPins: {
		contract: string;
		pinned: string | null;
		current: string;
	}[];
	feedbackOpen: number;
	feedbackUntriaged: number;
}

export const REQUIREMENT_FEEDBACK_VIA = [
	"requirement",
	"issue",
	"workflow",
	"release",
	"route",
] as const;
export type RequirementFeedbackVia = (typeof REQUIREMENT_FEEDBACK_VIA)[number];

export interface RequirementFeedbackItem {
	id: string;
	key: string;
	title: string;
	kind: FeedbackKind;
	severity: FeedbackSeverity;
	phase: FeedbackPhase;
	open: boolean;
	via: { type: RequirementFeedbackVia; key: string };
	route: FeedbackRouteView | null;
}

export interface CoverageIssue {
	issueId: string;
	displayId: string;
	title: string;
	status: string;
	/** The status's tone on this project (`issue-vocabulary.ts:issueStatusToneOn`). */
	tone: IssueStatusTone;
	/** The issue criterion number that traces here, its latest verdict, and whether it traces to an
	 *  earlier wording of the business criterion. */
	criterion: number;
	verdict: "pass" | "short" | "fail" | "skipped" | null;
	stale: boolean;
}

export interface RequirementCoverage {
	code: string;
	body: string;
	verdict: BcVerdict;
	issues: CoverageIssue[];
}

/** Where an agreed or accepted requirement is in delivery, read from its live issues and its BC
 *  coverage (workflow requirement-to-delivery step `rollup`); null for any other status. */
export const DELIVERY_PHASES = ["agreed", "in_delivery", "delivered"] as const;
export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];

export interface RequirementDelivery {
	phase: DeliveryPhase | null;
	liveIssues: number;
	startedIssues: number;
	closedIssues: number;
	criteriaCoverage: { criteria: number; passing: number; judged: number };
}

export interface RequirementStanding
	extends Standing<RequirementAttentionGroup, RequirementWaitingKind> {
	state: RequirementState;
	delivery: RequirementDelivery;
	facts: RequirementFacts;
	/** The open tasks of the delivery journey, each with its owner and SLA. */
	tasks: RequirementTask[];
	/** The revision the coverage is read against: the current one, else the newest. */
	shownRevision: number | null;
	coverage: RequirementCoverage[];
	owner: { id: string; name: string | null; kind: "human" | "agent" } | null;
	/** The newest write to the requirement, its revisions or its issues. */
	touchedAt: string;
}

export const REQUIREMENT_READINESS_GATES = ["off", "warn", "block"] as const;
export type RequirementReadinessGate =
	(typeof REQUIREMENT_READINESS_GATES)[number];
export const REQUIREMENT_READINESS_GATE_DEFAULT: RequirementReadinessGate =
	"off";

export interface BaselineReadiness {
	gate: Exclude<RequirementReadinessGate, "off">;
	suggestionId: string | null;
	ready: boolean;
	failed: string[];
}

/** Who a history entry came from, the filter the history is read by. */
export const HISTORY_SOURCES = ["person", "agent", "system"] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];

export interface RequirementHistoryEntry {
	id: string;
	at: string;
	source: HistorySource;
	who: string;
	/** What kind of record: "Revision", "Decision", "Question", "Suggestion", "Agreed", "Returned". */
	kind: string;
	text: string;
	/** The issue it was recorded on, when it came from one. */
	issue: string | null;
	/** A linked issue's status move, as raw statuses the reader labels; else null. */
	move: { from: string | null; to: string } | null;
}

export const acceptRevisionRequestSchema = z.strictObject({
	reason: z.string().max(4_000).nullable().optional(),
});
export const ACCEPT_REVISION_SHAPE =
	"{ reason? } — the signer's reason, kept on the revision and on the re-baseline it writes";

export const deferRequirementRequestSchema = z.strictObject({
	reason: z.string().max(4_000),
	targetPhase: z.string().trim().min(1).max(200).nullable().optional(),
});
export const DEFER_REQUIREMENT_SHAPE =
	"{ reason, targetPhase? } — why it leaves the current release, and the phase or release it is meant for";

export const undeferRequirementRequestSchema = z.strictObject({
	reason: z.string().max(4_000).nullable().optional(),
});
export const UNDEFER_REQUIREMENT_SHAPE =
	"{ reason? } — puts it back at the status it was deferred from";

export const acceptRequirementRequestSchema = z.strictObject({
	revision: z.number().int().min(1),
	reason: z.string().max(4_000).nullable().optional(),
});
export const ACCEPT_REQUIREMENT_SHAPE =
	"{ revision, reason? } — names the head revision whose delivery is accepted";

export const dropRequirementRequestSchema = z.strictObject({
	reason: z.string().max(4_000),
});
export const DROP_REQUIREMENT_SHAPE =
	"{ reason } — why it is not going to be built";

export const repinRequirementRequestSchema = z.strictObject({
	revision: z.number().int().min(1),
	reason: z.string().max(4_000).nullable().optional(),
});
export const REPIN_REQUIREMENT_SHAPE =
	"{ revision, reason? } — names the head revision; writes a baseline pinning each linked design's approved revision and each linked contract's current version";

const REQUIREMENT_CONTRACT_REF = /^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/;

export const linkRequirementContractRequestSchema = z.strictObject({
	contract: z.string().regex(REQUIREMENT_CONTRACT_REF),
});
export const LINK_REQUIREMENT_CONTRACT_SHAPE =
	"{ contract } — `<project>/<contract>`, a contract this project publishes or consumes; the next agree or re-pin pins its current version";

export interface RequirementDeferral {
	from: (typeof DEFERRABLE_STATUSES)[number];
	reason: string;
	targetPhase: string | null;
	deferredBy: string;
	deferredAt: string;
}

export interface RequirementSummaryView {
	id: string;
	key: string;
	title: string;
	status: string;
	state: RequirementState;
	currentRevision: number | null;
	latestRevision: { revision: number; state: string } | null;
	counts: RequirementFacts;
	waitingOn: WaitingOn<RequirementWaitingKind>;
	updatedAt: string;
}

export const REQUIREMENT_REFUSAL_CODES = [
	"REQUIREMENT_REVISION_STALE",
	"REQUIREMENT_REVISION_NOT_CURRENT",
	"REQUIREMENT_REVISION_NOT_DRAFT",
	"REQUIREMENT_REVISION_NOT_PROPOSED",
	"REQUIREMENT_REVISION_OPEN",
	"REQUIREMENT_DESIGN_UNAPPROVED",
	"REQUIREMENT_NOT_AGREED",
	"REQUIREMENT_ALREADY_AGREED",
	"REQUIREMENT_NOT_READY",
	"REQUIREMENT_ISSUE_LINKED_ELSEWHERE",
	"REQUIREMENT_NO_PLAN_TO_ADOPT",
	"REQUIREMENT_DEFERRED",
	"REQUIREMENT_DEFER_REASON_REQUIRED",
	"REQUIREMENT_NOT_DEFERRABLE",
	"REQUIREMENT_NOT_DEFERRED",
	"REQUIREMENT_HAS_LIVE_ISSUES",
	"REQUIREMENT_NOT_DELIVERED",
	"REQUIREMENT_CRITERIA_UNPROVEN",
	"REQUIREMENT_ALREADY_ACCEPTED",
	"REQUIREMENT_DROP_REASON_REQUIRED",
	"REQUIREMENT_NOT_DROPPABLE",
	"REQUIREMENT_PINS_CURRENT",
	"REQUIREMENT_CONTRACT_UNKNOWN",
	"REQUIREMENT_DESIGN_UNLINKED",
	"WORKFLOW_NODE_UNKNOWN",
	"WORKFLOW_NODE_AMBIGUOUS",
	"REVISION_REASON_REQUIRED",
	"CRITERION_CODE_UNKNOWN",
	"CRITERION_CODE_DUPLICATE",
	"CRITERION_SCENARIO_UNPARSEABLE",
	"REQUIREMENT_REFUSED",
	...PERMISSION_REFUSAL_CODES,
] as const;
export type RequirementRefusalCode = (typeof REQUIREMENT_REFUSAL_CODES)[number];
export const REQUIREMENT_REFUSAL_STATUSES = {
	REQUIREMENT_REVISION_STALE: 409,
} as const satisfies RefusalStatuses<RequirementRefusalCode>;

/** A requirement's key, `REQ-<seq>`. */
export const requirementKey = (seq: number) => `REQ-${seq}`;

/**
 * Whether a requirement has changed since an issue's plan was written: its head is another
 * revision than the one the plan names, or that revision was re-pinned onto newly approved designs
 * after the plan. Read, never stored; an issue with no plan has nothing to drift from.
 */
export function changedSincePlan(input: {
	plan: string | null;
	plannedRevision: number | null;
	currentRevision: number | null;
	plannedBaselineSeq?: number | null | undefined;
	latestBaselineSeq?: number | null | undefined;
}): boolean {
	if (!input.plan?.trim()) return false;
	if (input.plannedRevision !== input.currentRevision) return true;
	return (input.latestBaselineSeq ?? 1) > (input.plannedBaselineSeq ?? 1);
}

// The list and detail responses of /requirements, as core builds them (`requirements/read.ts`) and
// web-v2 reads them.

export interface RequirementSpec {
	goal?: string | undefined;
	personas?: string[] | undefined;
	scopeIn?: string[] | undefined;
	scopeOut?: string[] | undefined;
}

export interface RequirementSummary {
	id: string;
	key: string;
	title: string;
	status: RequirementStatus;
	currentRevision: number | null;
	latestRevision: { revision: number; state: RevisionState } | null;
	delivery: RequirementDelivery;
	createdAt: string;
	updatedAt: string;
	/** Where it stands, derived in core (`requirements/standing.ts`). */
	standing: RequirementStanding;
}

export interface RequirementCriterion {
	id: string;
	code: string;
	body: string;
	form: "statement" | "scenario";
	sinceRevision: number;
	retiredRevision: number | null;
}

export interface RequirementRevision {
	revision: number;
	state: RevisionState;
	baseRevision: number | null;
	spec: RequirementSpec;
	tldr: string | null;
	changeSummary: string | null;
	reason: string;
	authorId: string;
	authorName: string | null;
	authorKind: "human" | "agent";
	createdAt: string;
	proposedAt: string | null;
	decidedBy: string | null;
	decidedByName: string | null;
	decidedAt: string | null;
	returnReason: string | null;
	acceptReason: string | null;
	fromSuggestionId: string | null;
	criteria: RequirementCriterion[];
}

export interface RequirementPin {
	kind: "workflow-design" | "contract-version" | "mockup";
	workflowId: string | null;
	flow: string | null;
	designRevision: number | null;
	providerProjectId: string | null;
	contractSlug: string | null;
	contractVersion: string | null;
	mockupId: string | null;
}

export interface RequirementBaseline {
	revision: number;
	seq: number;
	act: (typeof BASELINE_ACTS)[number];
	agreedBy: string;
	agreedByName: string | null;
	agreedAt: string;
	reason: string | null;
	readiness: BaselineReadiness | null;
	pins: RequirementPin[];
}

export interface RequirementWorkflowLink {
	workflowId: string;
	flow: string;
	title: string;
	designStatus: string | null;
	approvedRevision: number | null;
}

export interface RequirementContractLink {
	providerProjectId: string;
	/** `<project>/<contract>`. */
	contract: string;
	contractSlug: string;
	/** The newest approved version; null while none is approved, so nothing is pinned for it yet. */
	currentVersion: string | null;
}

export interface RequirementIssueLink {
	issueId: string;
	displayId: string;
	title: string;
	status: string;
	/** awaiting_release is a person's turn only where the project requires a release approval. */
	tone: IssueStatusTone;
	plannedRevision: number | null;
	changedSincePlan: boolean;
}

export interface RequirementDetail extends RequirementSummary {
	/** Newest first. */
	revisions: RequirementRevision[];
	/** Of the current revision; empty when none is current. */
	criteria: RequirementCriterion[];
	workflows: RequirementWorkflowLink[];
	contracts: RequirementContractLink[];
	traces: (CriterionTraceView & { code: string })[];
	/** Newest first. */
	baselines: RequirementBaseline[];
	issues: RequirementIssueLink[];
	/** The viewer is a person allowed to accept, return or agree. */
	canSignOff: boolean;
	history: RequirementHistoryEntry[];
	readiness: {
		revision: number;
		ready: boolean;
		failed: string[];
		suggestionId: string;
		decidedAt: string | null;
	} | null;
	deferral: RequirementDeferral | null;
	feedback: RequirementFeedbackItem[];
}
