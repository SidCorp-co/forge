// Where a requirement stands — the read model core derives in `requirements/standing.ts` and every
// requirement surface draws: the attention group it is listed under, whom it waits on, the facts that
// decide it, and the coverage of each business criterion. Core writes the shapes; web-v2 reads the
// labels, so one value keeps one badge on every screen.

import { z } from "zod";
import { CHECKLIST_REFUSAL_CODES } from "./checklists.js";
import {
	type DecisionMaker,
	type EntityCommentView,
	REASON_TEXT_MAX,
} from "./comments.js";
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
	RequirementKind,
	RequirementPictureView,
} from "./requirement-pictures.js";
import type { Said } from "./said.js";
import type {
	Standing,
	StandingGroup,
	StandingGroupLabels,
	WaitingKind,
	WaitingOn,
} from "./standing.js";
import type { StandingTimes } from "./steward.js";
import type { CriterionTraceView } from "./workflow-health.js";
import type { WrittenLang } from "./written-lang.js";

/**
 * Every status is stored and moved only by an explicit act of a person, the assistant or an agent
 * (REQ-74 BC-8): nothing reads `in_delivery` or `delivered` off a requirement's issues or verdicts.
 */
export const REQUIREMENT_STATUSES = [
	"draft",
	"agreed",
	"in_delivery",
	"delivered",
	"accepted",
	"dropped",
	"deferred",
	"refused",
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** Agreed at a revision and not yet accepted: what its issues are delivering. */
export const DELIVERING_STATUSES = [
	"agreed",
	"in_delivery",
	"delivered",
] as const satisfies readonly RequirementStatus[];

/** Agreed at a revision, accepted or not: the statuses an issue is planned and linked under. */
export const AGREED_STATUSES = [
	...DELIVERING_STATUSES,
	"accepted",
] as const satisfies readonly RequirementStatus[];

export const isAgreedStatus = (status: string): boolean =>
	(AGREED_STATUSES as readonly string[]).includes(status);

export const isDeliveringStatus = (status: string): boolean =>
	(DELIVERING_STATUSES as readonly string[]).includes(status);

export const DEFERRABLE_STATUSES = ["draft", "agreed"] as const;

export const REQUIREMENT_DEFERRAL_ACTS = ["defer", "undefer"] as const;

export const BASELINE_ACTS = ["agree", "repin"] as const;

/** The lifecycle a person reads, every step a stored status. `dropped`, `deferred` and `refused` are off the line. */
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
	"refused",
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
	refused: "Refused",
};

export const REQUIREMENT_STATE_TONES: Record<RequirementState, StandingTone> = {
	draft: "neutral",
	agreed: "ready",
	in_delivery: "run",
	delivered: "you",
	accepted: "done",
	deferred: "neutral",
	dropped: "done",
	refused: "neutral",
};

export const REQUIREMENT_STATE_GLYPHS: Record<RequirementState, string> = {
	draft: "○",
	agreed: "◆",
	in_delivery: "●",
	delivered: "✓",
	accepted: "✓",
	deferred: "‖",
	dropped: "×",
	refused: "⊘",
};

export const REQUIREMENT_STATE_HINTS: Record<RequirementState, string> = {
	draft: "draft: being written, not agreed; nothing is built against it",
	agreed: "agreed: a person agreed a revision; an act moves it into delivery",
	in_delivery: "in_delivery: moved into delivery; an act marks it delivered",
	delivered: "delivered: marked delivered; an approver accepts the delivery",
	accepted: "accepted: delivered and accepted",
	deferred:
		"deferred: out of this release; nothing is built until a person undefers it",
	dropped: "dropped: no longer wanted",
	refused:
		"refused: its value check refused it, with a reason; a person may keep it with a one-line reason",
};

/** A revision's one state (docs/patterns/core-module.md "Revisions: one vocabulary"). */
export const REVISION_STATES = [
	"draft",
	"proposed",
	"current",
	"superseded",
	"withdrawn",
] as const;
export type RevisionState = (typeof REVISION_STATES)[number];

export const REVISION_STATE_LABELS: Record<RevisionState, string> = {
	draft: "Draft",
	proposed: "Proposed",
	current: "Current",
	superseded: "Superseded",
	withdrawn: "Withdrawn",
};

export const REVISION_STATE_TONES: Record<RevisionState, StandingTone> = {
	draft: "neutral",
	proposed: "you",
	current: "ready",
	superseded: "done",
	withdrawn: "done",
};

export const REVISION_STATE_GLYPHS: Record<RevisionState, string> = {
	draft: "○",
	proposed: "●",
	current: "✓",
	superseded: "×",
	withdrawn: "–",
};

export const REVISION_STATE_HINTS: Record<RevisionState, string> = {
	draft: "draft: still being written",
	proposed: "proposed: waiting for a person to accept or return it",
	current: "current: the accepted revision",
	superseded: "superseded: replaced by a later accepted revision",
	withdrawn: "withdrawn: a draft dropped without being proposed",
};

/** The list's attention groups, in the order they are drawn. */
export const REQUIREMENT_ATTENTION_GROUPS = [
	"needs_you",
	"stuck",
	"moving",
	"waiting",
	"deferred",
	"done",
] as const satisfies readonly StandingGroup[];
export type RequirementAttentionGroup =
	(typeof REQUIREMENT_ATTENTION_GROUPS)[number];

export const REQUIREMENT_ATTENTION_LABELS: StandingGroupLabels<RequirementAttentionGroup> =
	{
		needs_you: {
			label: "Needs you",
			tone: "you",
			collapsed: false,
		},
		stuck: {
			label: "Stuck",
			tone: "blocked",
			collapsed: false,
		},
		moving: {
			label: "Moving",
			tone: "run",
			collapsed: false,
		},
		waiting: {
			label: "Someone else’s turn",
			tone: "neutral",
			collapsed: false,
		},
		deferred: {
			label: "Deferred",
			tone: "neutral",
			collapsed: true,
		},
		done: { label: "Done", tone: "done", collapsed: true },
	};

/** Whom a requirement waits on: the viewer, another person, an agent (the master, a draft's agent
 *  author), its issues, the release that ships them on its own, or nobody (done, or no owner to act). */
export const REQUIREMENT_WAITING_KINDS = [
	"you",
	"person",
	"agent",
	"issue",
	"release",
	"none",
] as const satisfies readonly WaitingKind[];
export type RequirementWaitingKind = (typeof REQUIREMENT_WAITING_KINDS)[number];

/** What a requirement's wait is about, where it is one thing a page can link: a parked issue, or the release that ships its landed issues. */
export const REQUIREMENT_WAIT_REFERS = ["issue", "release"] as const;
export type RequirementWaitRefers = (typeof REQUIREMENT_WAIT_REFERS)[number];

/**
 * Whom a requirement waits on. Where the wait is about one issue or one release, `refers` says which
 * and `ref` names it: the parked issue's key, or the version the next cut takes (null where the
 * release has no number yet), so a reader links the issue or the release instead of guessing from
 * the words.
 */
export interface RequirementWaitingOn
	extends WaitingOn<RequirementWaitingKind> {
	refers?: RequirementWaitRefers;
}

/** The tasks of workflow requirement-to-delivery a requirement holds open, derived on read. */
const REQUIREMENT_TASK_KINDS = ["breakdown", "check", "re-plan"] as const;
export type RequirementTaskKind = (typeof REQUIREMENT_TASK_KINDS)[number];

/** Step `breakdown`: the master proposes the breakdown within this many working days of the agree. */
export const BREAKDOWN_SLA_WORKING_DAYS = 2;
/** Step `check`: the BA checks the business criteria within this many working days of delivery. */
export const CHECK_SLA_WORKING_DAYS = 5;

/** A task the design gives an SLA: the breakdown and the BA's check. */
interface RequirementSlaTask {
	kind: "breakdown" | "check";
	/** The role the design gives the task: the project master breaks down, the BA checks. */
	owner: "Project master" | "BA";
	/** The requirement revision the task is for; a revision holds at most one of each kind. */
	revision: number;
	openedAt: string;
	dueAt: string;
	overdue: boolean;
}

/**
 * Step `delivery`, opened by `impact`: one re-plan per flagged issue and revision, the master's.
 * The design gives it no SLA, so it carries no due date; the flag (REQUIREMENT_CHANGED_SINCE_PLAN)
 * stands on the issue and in its run's context until the issue is re-planned.
 */
interface RequirementReplanTask {
	kind: "re-plan";
	owner: "Project master";
	revision: number;
	/** When the revision the task is for became current. */
	openedAt: string;
	dueAt: null;
	overdue: false;
	issueId: string;
	displayId: string;
}

export type RequirementTask = RequirementSlaTask | RequirementReplanTask;

/** A business criterion's proof: its linked issue criteria and their latest verdicts. */
export const BC_VERDICTS = [
	"passing",
	"failing",
	"stale",
	"not_live",
	"not_judged",
	"gap",
] as const;
export type BcVerdict = (typeof BC_VERDICTS)[number];

export const BC_VERDICT_LABELS: Record<BcVerdict, string> = {
	passing: "Passing",
	failing: "Failing",
	stale: "Stale",
	not_live: "Not live",
	not_judged: "Not judged",
	gap: "Gap",
};

export const BC_VERDICT_TONES: Record<BcVerdict, StandingTone> = {
	passing: "ready",
	failing: "err",
	stale: "neutral",
	not_live: "neutral",
	not_judged: "neutral",
	gap: "you",
};

export const BC_VERDICT_HINTS: Record<BcVerdict, string> = {
	passing:
		"passing: the newest verdict that counts is a pass; a short never counts",
	failing: "failing: the newest verdict on a tracing criterion is a fail",
	stale: "stale: traces only an earlier wording; tie it again, then judge it",
	not_live:
		"not_live: judged only on builds the live one lacks; judge it on live",
	not_judged: "not_judged: no verdict on this wording counts yet",
	gap: "gap: no issue criterion traces to it and no verdict judged it",
};

export interface RequirementFacts {
	/** Business criteria of the shown revision whose coverage is passing. */
	passing: number;
	/** Business criteria with a verdict either way (passing or failing). */
	judged: number;
	criteria: number;
	issuesRunning: number;
	issuesTotal: number;
	/** The open revision waiting on a sign-off, else null. */
	proposedRevision: number | null;
	/** The open revision still being written, else null. */
	draftRevision: number | null;
	/** Linked designs the latest baseline leaves unpinned (pinned null) or pins below their approved revision. */
	stalePins: {
		flow: string;
		/** The design's own title, the name a person reads. */
		title: string;
		pinned: number | null;
		approved: number;
	}[];
	/** Linked contracts whose current version is not the one the latest baseline pins. */
	staleContractPins: {
		contract: string;
		pinned: string | null;
		current: string;
	}[];
	/** Linked designs holding no approved revision; an agree is refused while any is listed. */
	unapprovedDesigns: {
		flow: string;
		title: string;
		designStatus: string | null;
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

/** A file an issue keeps that a verdict's evidence names: where a person reaches the clip or picture QA recorded. */
export interface CoverageFile {
	attachmentId: string;
	name: string;
	mime: string;
}

/**
 * The project of the other side of a requirement–issue link, where the two are not the same
 * project's: a sibling project of the requirement's organization whose issue delivers it, or, read
 * from the issue, the project whose requirement it delivers. Null where both are one project's.
 */
export interface OtherProject {
	id: string;
	slug: string;
	name: string;
}

export interface CoverageIssue {
	issueId: string;
	/** Its key; `<project-slug>/<key>` where it is another project's issue (`otherProject`). */
	displayId: string;
	otherProject: OtherProject | null;
	title: string;
	status: string;
	/** The status's tone on this project (`issue-vocabulary.ts:issueStatusToneOn`). */
	tone: IssueStatusTone;
	/** The issue criterion number that traces here, its latest verdict, and whether it traces to an
	 *  earlier wording of the business criterion. */
	criterion: number;
	verdict: "pass" | "short" | "fail" | "skipped" | null;
	/** When that verdict was recorded (ISO); null while there is none. */
	verdictAt: string | null;
	/** What that verdict names as the thing it was judged against, in words (`commit 1a2b…`,
	 *  `runtime 3c4d…`, `design issue-lifecycle rev 14`, `contract forge/api@1.2.0`); null with no verdict. */
	identity: string | null;
	/** The note the verdict was written with (its own reason); null where none was written or there is no verdict. */
	note: string | null;
	/** The files that verdict's evidence names which the issue keeps, a clip or a picture among them. */
	files: CoverageFile[];
	/** The commit that verdict was judged at, or the commit its runtime served; null where it names
	 *  none or its runtime resolves to none. */
	commit: string | null;
	/** Whether the live build holds that commit; null where it was not read (no commit, no probe,
	 *  no answer). A verdict at a commit counts only where this is true: one the live build does not
	 *  hold, and one nobody could check, never count, `notCounted` naming which. */
	inLiveBuild: boolean | null;
	/** Why this pass, short or fail does not count toward the criterion; null where it counts or is
	 *  no judgement (none yet, or could not judge). */
	notCounted: string | null;
	stale: boolean;
}

/**
 * A business criterion judged on the running build at the requirement itself (ISS-588): the proof of
 * a capability that already shipped, which no issue carries (REQ-45 r3 BC-8). Read on the criterion
 * it judged, newest first, held to the live build as a commit verdict on an issue is.
 */
export interface CoverageRequirementVerdict {
	verdictId: string;
	verdict: "pass" | "short" | "fail" | "skipped";
	/** When it was recorded (ISO). */
	verdictAt: string;
	/** What it was judged against, in words (`commit 1a2b…`); null for a skip, which names nothing. */
	identity: string | null;
	/** Its own reason; null where none was written. */
	note: string | null;
	/** What it cites: links or repository paths at its commit. */
	evidence: string[];
	commit: string | null;
	/** Whether the live build holds that commit (`CoverageIssue.inLiveBuild`). */
	inLiveBuild: boolean | null;
	/** Why it does not count toward the criterion (`CoverageIssue.notCounted`); null where it counts or is a skip. */
	notCounted: string | null;
	/** It judged an earlier wording of the criterion, so it does not count for this one. */
	stale: boolean;
}

/** The one verdict a business criterion's coverage reads: the newest pass, short or fail recorded on
 *  an issue criterion tracing its current wording, or on the criterion itself, whose identity coverage
 *  could check (a commit the live build is read to hold, or the pinned design revision or contract
 *  version). `source` says which of the two it was. */
export type CoverageCount = CoverageCountCommon &
	(
		| { source: "issue"; issueId: string; displayId: string; criterion: number }
		| { source: "requirement"; verdictId: string }
	);

interface CoverageCountCommon {
	/** A pass or a fail: a short never counts on coverage (REQ-35 decision 7b261fca). */
	verdict: "pass" | "fail";
	/** When it was recorded (ISO). */
	at: string;
	/** What it was judged against, in words (`CoverageIssue.identity`). */
	identity: string;
	commit: string | null;
	inLiveBuild: boolean | null;
}

export interface RequirementCoverage {
	code: string;
	body: string;
	verdict: BcVerdict;
	issues: CoverageIssue[];
	/** Its verdicts recorded at the requirement itself (`CoverageRequirementVerdict`), newest first. */
	verdicts: CoverageRequirementVerdict[];
	/** The verdict the coverage reads, so a person sees why it reads as it does; null where none counts. */
	counts: CoverageCount | null;
	/** Why the criterion reads as it does where no verdict counts (stale, not live, not judged with
	 *  judgements that do not count), in one sentence shown beside its word; null where one counts. */
	why: string | null;
	/** On a gap, why the newest accepted breakdown naming this criterion left it without an issue
	 *  (its `uncovered[]` reason); null where no accepted breakdown says. */
	uncoveredReason: string | null;
}

/** A requirement's business criteria counted by their coverage: every live criterion, those passing,
 *  and those judged (passing or failing). */
export interface CriteriaCoverage {
	criteria: number;
	passing: number;
	judged: number;
}

/** The one count of a coverage: what the delivery rollup, the standing and a release's requirement
 *  bar all read, so the three never disagree. */
export function criteriaCoverageOf(
	coverage: readonly { verdict: BcVerdict }[],
): CriteriaCoverage {
	return {
		criteria: coverage.length,
		passing: coverage.filter((c) => c.verdict === "passing").length,
		judged: coverage.filter(
			(c) => c.verdict === "passing" || c.verdict === "failing",
		).length,
	};
}

/** What its live issues and BC coverage count; which step it stands at is its stored status alone. */
export interface RequirementDelivery {
	liveIssues: number;
	startedIssues: number;
	closedIssues: number;
	criteriaCoverage: CriteriaCoverage;
}

export interface RequirementStanding
	extends Standing<RequirementAttentionGroup, RequirementWaitingKind> {
	waitingOn: RequirementWaitingOn;
	state: RequirementState;
	/**
	 * The step that follows the one it stands at, as Requirement lifecycle r15 draws each step's
	 * Next: (REQ-34 BC-19); null where nothing follows (accepted, dropped). A deferred one goes back
	 * to the step it left.
	 */
	next: RequirementState | null;
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
	/** Since when its wait stands, when it falls due, and whether it is stuck and why (REQ-48 BC-8). */
	times: StandingTimes;
	/** When it came to stand in `state`: its last status move; what the list's age reads, which an
	 *  edit moving no state (an area, a short name) never restarts. */
	stateSince: string;
	/** Where it was accepted by decision over an incomplete acceptance checklist, what was waived; else null. */
	acceptedByDecision: RequirementAcceptanceDecision | null;
}

/**
 * An accept by decision: the acceptance checklist's blocking items a holder of the accept permission
 * waived, with why. It counts as done; nothing it waived reads as proven.
 */
export interface RequirementAcceptanceDecision {
	reason: string;
	decidedAt: string;
	waived: { question: string; label: string; detail: string }[];
}

export const REQUIREMENT_READINESS_GATES = ["off", "warn", "block"] as const;
export type RequirementReadinessGate =
	(typeof REQUIREMENT_READINESS_GATES)[number];
/**
 * How close another requirement's head vector must sit to this head's for an agree to read it as a
 * near-duplicate (requirement-to-delivery `ready`): the agree waits until a duplicate suggestion
 * naming it is decided.
 */
export const REQUIREMENT_NEAR_DUPLICATE_SIMILARITY = 0.9;

/**
 * requirement-to-delivery `similar` -> `ready`: whether the near-duplicate read ran on the head. A
 * head with no stored vector (embeddings down, withheld by policy, not written yet) is not compared,
 * and the agree says so rather than reading as if no near-duplicate exists.
 */
/** Whether dedup compared the head; `says` is `why` as said, absent on a check stored before core said it. */
export type RequirementDedupCheck =
	| { ran: true }
	| { ran: false; why: string; says?: { why: Said } };

/**
 * What an agree read of readiness at the head. Absent where the gate is off and dedup ran; at gate
 * `off` it is written only to record that dedup was not checked.
 */
export interface BaselineReadiness {
	gate: RequirementReadinessGate;
	suggestionId: string | null;
	ready: boolean;
	failed: string[];
	/** Absent on a baseline written before the agree recorded it. */
	dedup?: RequirementDedupCheck;
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
	/** `who` and `text` as said (`said.ts`): a person's words carried as written, Forge's by key. */
	says: { who: Said; text: Said; kind: Said };
	/** The issue it was recorded on, when it came from one. */
	issue: string | null;
	/** A linked issue's status move, as raw statuses the reader labels; else null. */
	move: { from: string | null; to: string } | null;
}

// a missing or blank reason passes the shape and is refused by name in core
// (REQUIREMENT_SIGNOFF_REASON_REQUIRED, REQ-4 BC-16), as a re-pin's is
export const acceptRevisionRequestSchema = z.strictObject({
	reason: z.string().max(REASON_TEXT_MAX).nullable().optional(),
});
export const ACCEPT_REVISION_SHAPE =
	"{ reason } — why it is accepted and on whose authority, kept on the revision and on the re-baseline it writes";

export const deferRequirementRequestSchema = z.strictObject({
	reason: z.string().max(REASON_TEXT_MAX),
	targetPhase: z.string().trim().min(1).max(200).nullable().optional(),
});
export const DEFER_REQUIREMENT_SHAPE =
	"{ reason, targetPhase? } — why it leaves the current release, and the phase or release it is meant for";

export const undeferRequirementRequestSchema = z.strictObject({
	reason: z.string().max(REASON_TEXT_MAX),
});
export const UNDEFER_REQUIREMENT_SHAPE =
	"{ reason } — why it comes back into the current release; puts it back at the status it was deferred from";

export const acceptRequirementRequestSchema = z.strictObject({
	revision: z.number().int().min(1),
	reason: z.string().max(REASON_TEXT_MAX).nullable().optional(),
	byDecision: z.boolean().optional(),
});
export const ACCEPT_REQUIREMENT_SHAPE =
	"{ revision, reason?, byDecision? } — names the head revision whose delivery is accepted; byDecision: true accepts over an incomplete acceptance checklist, recording each item it waives, and needs a reason";

/**
 * A business criterion judged on the running build at the requirement itself (ISS-588): a capability
 * that already shipped is proven here, never by an issue whose only work is verifying it (REQ-45 r3
 * BC-8). A pass, short or fail names the whole commit it was judged at and cites what it was taken
 * from; a skip says why.
 */
export const recordRequirementVerdictRequestSchema = z.strictObject({
	criterion: z.string().trim().min(1).max(16),
	verdict: z.string().trim().min(1).max(32),
	reason: z.string().trim().max(REASON_TEXT_MAX).nullable().optional(),
	identity: z
		.strictObject({
			kind: z.literal("commit"),
			sha: z.string().trim().min(1).max(64),
		})
		.nullable()
		.optional(),
	evidence: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
	/**
	 * The run recording it, as on an issue verdict (core `issues/criteria/input-schemas.ts` `run`): the box's declared run id, or
	 * core's session or run id, held to a live run of the calling box on this project.
	 */
	run: z.string().trim().min(1).max(200).optional(),
});
export type RecordRequirementVerdictRequest = z.infer<
	typeof recordRequirementVerdictRequestSchema
>;
export const RECORD_REQUIREMENT_VERDICT_SHAPE =
	"{ criterion: 'BC-n', verdict: pass | short | fail | skipped, reason?, identity?: { kind: 'commit', sha: <40 hex> }, evidence?: [link or repository path], run?: <the run recording it, as on an issue verdict> } — a pass, short or fail names the commit judged and cites evidence; a skip gives its reason";

/** One requirement-level verdict as its list answers it, the criterion it judged by code. */
export interface RequirementVerdictRow {
	id: string;
	criterion: string;
	verdict: "pass" | "short" | "fail" | "skipped";
	reason: string | null;
	evidence: string[];
	commit: string | null;
	/** The run session that recorded it, as the call's `run` named it; null for a call naming none. */
	run: string | null;
	/** Who wrote it: a person or an agent account; null where the account is gone. */
	by: { id: string; name: string | null; agency: "human" | "agent" } | null;
	at: string;
}

/** The explicit moves into delivery and delivered (REQ-74 BC-8): why, kept on the move. */
export const moveRequirementRequestSchema = z.strictObject({
	reason: z.string().max(REASON_TEXT_MAX).nullable().optional(),
});
export const START_DELIVERY_SHAPE =
	"{ reason? } — moves an agreed requirement into delivery; it needs a live linked issue";
export const MARK_DELIVERED_SHAPE =
	"{ reason? } — moves a requirement in delivery to delivered; every live criterion needs a pass on the running build";

export const dropRequirementRequestSchema = z.strictObject({
	reason: z.string().max(REASON_TEXT_MAX),
});
export const DROP_REQUIREMENT_SHAPE =
	"{ reason } — why it is not going to be built";

export const repinRequirementRequestSchema = z.strictObject({
	revision: z.number().int().min(1),
	reason: z.string().max(REASON_TEXT_MAX).nullable().optional(),
});
export const REPIN_REQUIREMENT_SHAPE =
	"{ revision, reason } — names the head revision and says why it now follows; writes a baseline pinning each linked design's approved revision and each linked contract's current version";

/** Each named issue by key or uuid; left out, every draft issue linked to the requirement. */
export const promoteRequirementDraftsRequestSchema = z.strictObject({
	issues: z.array(z.string().trim().min(1).max(200)).min(1).max(200).optional(),
});
export const PROMOTE_REQUIREMENT_DRAFTS_SHAPE =
	"{ issues? } — the draft issues to promote to open, each by key or uuid; left out, every draft issue linked to the requirement";

/**
 * A requirement's linked issues still at `draft`, which a holder of requirements.approve and issues.admit
 * promotes to `open`. The standing's "promote N draft issues" line counts these, the promote act moves these, and
 * the web draws the act from these, so the ask and its act never disagree. Only a requirement at one
 * of `AGREED_STATUSES` has issues to promote: those are the statuses an issue is linked under.
 */
export function draftIssuesToPromote<T extends { status: string }>(
	requirementStatus: string,
	issues: readonly T[],
): T[] {
	if (!isAgreedStatus(requirementStatus)) return [];
	return issues.filter((i) => i.status === "draft");
}

export interface PromotedDraftIssue {
	issueId: string;
	displayId: string;
}

/**
 * One refusal of a draft the promote could not move: its own move's code, its words for a person,
 * and where in that move it points (`/answers/<question>` for a checklist gap; empty for the move
 * as a whole). A draft refused for several reasons is named once per refusal.
 */
export interface RefusedDraftIssue extends PromotedDraftIssue {
	code: string;
	path: string;
	detail: string;
}

/**
 * What a promote answers when at least one draft moved: each draft moves on its own status move, so
 * one refused is named here while the rest still moved. When none moved the act is refused whole.
 */
export interface PromoteDraftsAnswer {
	requirement: RequirementDetail;
	promoted: PromotedDraftIssue[];
	refused: RefusedDraftIssue[];
}

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
	area: string | null;
	shortName: string | null;
	status: string;
	state: RequirementState;
	currentRevision: number | null;
	latestRevision: { revision: number; state: string } | null;
	counts: RequirementFacts;
	waitingOn: RequirementWaitingOn;
	updatedAt: string;
}

export const REQUIREMENT_REFUSAL_CODES = [
	"REQUIREMENT_REVISION_STALE",
	"REQUIREMENT_REVISION_NOT_CURRENT",
	"REQUIREMENT_REVISION_NOT_DRAFT",
	"REQUIREMENT_REVISION_EMPTY",
	"REQUIREMENT_AREA_UNKNOWN",
	"REQUIREMENT_AREA_DUPLICATE",
	/** An area left out of the list still holds requirements: move them first, so none loses its area unseen. */
	"REQUIREMENT_AREA_IN_USE",
	"REQUIREMENT_SHORT_NAME_TOO_LONG",
	/** The owner named is not a member of the project, so nothing it owns would reach them. */
	"REQUIREMENT_OWNER_NOT_MEMBER",
	"REQUIREMENT_PLACEMENT_NOT_PROPOSED",
	"REQUIREMENT_REVISION_NOT_PROPOSED",
	"REQUIREMENT_REVISION_WITHDRAWN",
	"REQUIREMENT_DROPPED",
	"REQUIREMENT_REVISION_OPEN",
	"REQUIREMENT_DESIGN_UNAPPROVED",
	"REQUIREMENT_NOT_AGREED",
	"REQUIREMENT_ALREADY_AGREED",
	"REQUIREMENT_DUPLICATE_UNDECIDED",
	"REQUIREMENT_DUPLICATE_TARGET_INVALID",
	"REQUIREMENT_ISSUE_LINKED_ELSEWHERE",
	/** The issue named is a project's of another organization: a requirement is delivered only within its own. */
	"REQUIREMENT_ISSUE_OTHER_ORG",
	"REQUIREMENT_NO_PLAN_TO_ADOPT",
	"REQUIREMENT_DEFERRED",
	"REQUIREMENT_DEFER_REASON_REQUIRED",
	"REQUIREMENT_UNDEFER_REASON_REQUIRED",
	"REQUIREMENT_NOT_DEFERRABLE",
	"REQUIREMENT_NOT_DEFERRED",
	"REQUIREMENT_HAS_LIVE_ISSUES",
	"REQUIREMENT_NOT_DELIVERED",
	"REQUIREMENT_ALREADY_ACCEPTED",
	"REQUIREMENT_DROP_REASON_REQUIRED",
	"REQUIREMENT_SIGNOFF_REASON_REQUIRED",
	"REQUIREMENT_NOT_DROPPABLE",
	/** The move into delivery: no live issue is linked to it. */
	"REQUIREMENT_NO_LIVE_ISSUE",
	/** The move to delivered: a live criterion has no pass on the running build. */
	"REQUIREMENT_CRITERIA_UNPROVEN",
	"REQUIREMENT_DECISION_REASON_REQUIRED",
	/** An accept by decision: a linked issue is neither closed nor dropped. */
	"REQUIREMENT_HAS_UNFINISHED_ISSUES",
	/** A requirement-level verdict names a criterion code with no wording live at the head. */
	"REQUIREMENT_VERDICT_CRITERION_UNKNOWN",
	/** A requirement-level verdict on a requirement that is not agreed, in delivery or delivered. */
	"REQUIREMENT_VERDICT_NOT_DELIVERING",
	/** A requirement-level pass, short or fail that cites nothing. */
	"REQUIREMENT_VERDICT_UNCITED",
	// the rules every verdict meets, whichever door writes it (`issues/criteria/verdict-input.ts`)
	"VERDICT_VALUE_UNKNOWN",
	"VERDICT_SKIP_REASON_REQUIRED",
	"VERDICT_IDENTITY_REQUIRED",
	"VERDICT_COMMIT_NOT_FULL",
	"VERDICT_SECRET",
	// the run a verdict names, held by the issue door's rule (`issues/pattern-runs.ts:runOfCall`)
	"VERDICT_RUN_UNKNOWN",
	"VERDICT_SESSION_NOT_ADMITTED",
	"REQUIREMENT_PINS_CURRENT",
	"REQUIREMENT_CONTRACT_UNKNOWN",
	"REQUIREMENT_SIGNOFF_FORBIDDEN",
	"REQUIREMENT_REQUEST_OWN_PROJECT",
	"REQUIREMENT_BINDING_NOT_INDEXED",
	"REQUIREMENT_DESIGN_UNLINKED",
	"REQUIREMENT_DESIGN_UNKNOWN",
	// a design withdrawn before any revision was approved draws no requirement (`workflows.ts`)
	"WORKFLOW_DESIGN_WITHDRAWN",
	"REQUIREMENT_NO_DRAFT_ISSUES",
	"REQUIREMENT_ISSUE_NOT_LINKED",
	"REQUIREMENT_ISSUE_NOT_DRAFT",
	"REQUIREMENT_OPEN_QUESTION_UNKNOWN",
	"WORKFLOW_NODE_UNKNOWN",
	"WORKFLOW_NODE_AMBIGUOUS",
	"REVISION_REASON_REQUIRED",
	"CRITERION_CODE_UNKNOWN",
	"CRITERION_CODE_DUPLICATE",
	"CRITERION_SCENARIO_UNPARSEABLE",
	"CRITERIA_DOCUMENT_REFUSED",
	"REQUIREMENT_PICTURE_KIND_MISMATCH",
	"REQUIREMENT_PICTURE_ROW_INCOMPLETE",
	"REQUIREMENT_PICTURE_ALT_REQUIRED",
	"REQUIREMENT_PICTURE_NOT_DRAWN",
	"REQUIREMENT_REFUSED",
	// the agree and the accept are judged by their checklists (`checklist-registry.ts`)
	...CHECKLIST_REFUSAL_CODES,
	...PERMISSION_REFUSAL_CODES,
] as const;
export type RequirementRefusalCode = (typeof REQUIREMENT_REFUSAL_CODES)[number];
export const REQUIREMENT_REFUSAL_STATUSES = {
	REQUIREMENT_REVISION_STALE: 409,
} as const satisfies RefusalStatuses<RequirementRefusalCode>;

/** A requirement's key, `REQ-<seq>`. */
export const requirementKey = (seq: number) => `REQ-${seq}`;

/**
 * Whether an issue's plan is flagged by a change to its requirement (requirement-to-delivery
 * `impact`): a later revision changed or retired a BC one of its criteria traces. A plan that names
 * no revision has nothing to compare against and is flagged while the requirement has a head. Read,
 * never stored; an issue with no plan has nothing to drift from, and a re-pin changes no BC.
 */
export function changedSincePlan(input: {
	plan: string | null;
	plannedRevision: number | null;
	currentRevision: number | null;
	/** BCs the issue traces that a revision after its planned one, up to the head, changed. */
	changedTraced: readonly ChangedTrace[];
}): boolean {
	if (!input.plan?.trim()) return false;
	if (input.plannedRevision === null) return input.currentRevision !== null;
	if (input.plannedRevision === input.currentRevision) return false;
	return input.changedTraced.length > 0;
}

/** A BC wording an issue criterion traces, retired at `revision` (reworded or removed). */
export interface ChangedTrace {
	code: string;
	revision: number;
}

// The list and detail responses of /requirements, as core builds them (`requirements/read.ts`) and
// web-v2 reads them.

export interface RequirementOpenQuestion {
	question: string;
	whoAnswers: string;
	blocking: boolean;
	/** The question it is asked as on the requirement; core fills it when the revision is written. */
	questionId?: string | undefined;
}

export interface RequirementAssumption {
	text: string;
	/** Who holds it: the person or role that answers for it being true. */
	owner: string;
	/** How it will be confirmed, and by when if that is known. */
	confirmBy: string;
	/** The record it was taken from, by its intake ref (REQ-n, FB-n, workflow:<flow>, release:<version>), where one is named. */
	source?: string | undefined;
	/** The answer the assistant filled (an intake field) and the value it assumed there. */
	field?: string | undefined;
	value?: string | undefined;
	/**
	 * Derived on read (REQ-34 BC-26): the revision shown no longer holds the assumed value in that
	 * field, so a later edit corrected it. The assumption stays visible, marked, never silently gone.
	 */
	corrected?: boolean | undefined;
}

export interface RequirementSpec {
	goal?: string | undefined;
	personas?: string[] | undefined;
	scopeIn?: string[] | undefined;
	scopeOut?: string[] | undefined;
	openQuestions?: RequirementOpenQuestion[] | undefined;
	assumptions?: RequirementAssumption[] | undefined;
}

/** Where a question on a requirement was asked: of the requirement itself, on one of its issues, or by a run on no issue. */
export type RequirementQuestionPlace =
	| { kind: "requirement" }
	| { kind: "issue"; key: string; title: string }
	| { kind: "run" };

/**
 * A question standing on a requirement, read in core (`requirements/read.ts`): asked of it (a BA
 * clarification, or an open question of a revision's spec), or about it from one of its issues or
 * a run. `whoAnswers` and `blocking` are the head revision's spec entry naming it; a question no
 * entry names blocks nothing.
 */
export interface RequirementQuestionView {
	id: string;
	prompt: string;
	status: "open" | "answered" | "void" | "expired" | "needs_info";
	place: RequirementQuestionPlace;
	whoAnswers: string | null;
	blocking: boolean;
	/** The round an answer names; a question asked of the requirement takes its answer in words. */
	round: number;
	askedAt: string;
	answer: { text: string; at: string; by: string | null } | null;
}

/** An answered question the requirement's Decisions tab rolls up beside its decisions. */
export interface RequirementAnswerView {
	questionId: string;
	prompt: string;
	answer: string;
	answeredAt: string;
	answeredBy: string | null;
	place: RequirementQuestionPlace;
}

/** GET /projects/:id/requirements/:req/decisions — newest first, each list on its own. */
export interface RequirementDecisionsResponse {
	decisions: EntityCommentView[];
	answers: RequirementAnswerView[];
	/** Whose decisions are listed; a person's by default. */
	by: DecisionMaker;
	/** How many decisions the other makers hold here, folded away; 0 when `by` is all. */
	folded: number;
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
	/** Its business area (REQ-29 BC-1); null until a person sets or accepts one. */
	area: RequirementAreaRef | null;
	/** At most six words; null until a person sets or accepts one, the title reads in its place. */
	shortName: string | null;
	/** What the assistant proposed, waiting for a person; null when nothing waits. */
	placementProposal: {
		area: RequirementAreaRef | null;
		shortName: string | null;
	} | null;
}

export interface RequirementAreaRef {
	id: string;
	name: string;
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
	/** Why it was written; null until its author answers the question the create asked (REQ-34 BC-17). */
	reason: string | null;
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
	/** The language its reason, summary and spec were written in; null when written before it was kept. */
	writtenLang: WrittenLang | null;
	/** What it is (REQ-35): named by the draft, corrected by its author; null while none is named. */
	kind: RequirementKind | null;
	/** Its one picture, a rough sketch fitting its kind, shown with no accept; null while none is drawn. */
	picture: RequirementPictureView | null;
	criteria: RequirementCriterion[];
	/** What it did to the criteria of the revision it was written against, computed, never typed; null where it has no base. */
	criteriaChanges: RequirementCriteriaChanges | null;
}

/**
 * A revision's criteria against its base (REQ-34 r2 BC-7, Requirement lifecycle r15 rev_check): the
 * codes it added, reworded and retired, read from the criteria rows, never from its change summary.
 */
export interface RequirementCriteriaChanges {
	against: number;
	added: string[];
	changed: string[];
	removed: string[];
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
	agreedBy: string | null;
	/** `kernel`: Forge's own follow of a pin-only design approval, written before nothing re-pinned by itself; it names no user, and nothing writes one now. */
	agreedKind: "person" | "kernel";
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
	/** Its key; `<project-slug>/<key>` where it is another project's issue (`otherProject`). */
	displayId: string;
	otherProject: OtherProject | null;
	title: string;
	status: string;
	/** awaiting_release is a person's turn only where the project requires a release approval. */
	tone: IssueStatusTone;
	plannedRevision: number | null;
	changedSincePlan: boolean;
	/** The release that shipped it, by version; null while no shipped release carries it. */
	shippedIn: { version: string; at: string } | null;
	/** With no production environment, the landing that closed it: branch and commit, no version. */
	landedIn: { branch: string; commit: string; at: string } | null;
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
	/** The releases that shipped its issues, oldest ship first, each once; one of another project names it. */
	releases: { version: string; at: string; otherProject: OtherProject | null }[];
	/** The viewer is a person allowed to accept, return or agree. */
	canSignOff: boolean;
	/**
	 * The viewer may move the delivery and accept it, by its checklist or by decision: what the
	 * project's `approvals.accept` asks (requirements.approve where on, project.write where off).
	 */
	canAccept: boolean;
	/**
	 * The viewer may promote its draft issues: a signer who also holds issues.admit. Only they are asked
	 * to (question 3b8292dc); who may admit an issue is not widened by signing.
	 */
	canPromote: boolean;
	history: RequirementHistoryEntry[];
	/** Whether an agree at the head would compare it for near-duplicates; null with no head. */
	dedup: RequirementDedupCheck | null;
	deferral: RequirementDeferral | null;
	feedback: RequirementFeedbackItem[];
	/** Another project's contract request this draft landed as (E2); only this project agrees it. */
	request: RequirementContractRequest | null;
	/** The screen bindings inside the designs its latest baseline pins (`pins`). */
	bindings: RequirementScreenBinding[];
	/** The questions standing on it, open first, then newest first. */
	questions: RequirementQuestionView[];
	/** How many of `questions` are open: what is still unclear. */
	unclear: number;
}

export interface RequirementContractRequest {
	projectId: string;
	project: string;
	/** `<provider>/<contract>`. */
	contract: string;
}

/** A contract element a screen of a pinned design binds, and whether its contract type can be bound. */
export interface RequirementScreenBinding {
	workflowId: string;
	flow: string;
	designRevision: number;
	step: string;
	/** `<provider>/<contract>`. */
	contract: string;
	element: string;
	/** The contract's type at its current version; null while it has none. */
	contractType: string | null;
	/** The version the baseline pins of that contract; null when it pins none. */
	pinnedVersion: string | null;
	/**
	 * `impact`: the newest approved version past the pin that removed or broke the bound element, so
	 * the screen is affected and the BA re-agrees to re-baseline; null when none did.
	 */
	brokenBy: string | null;
	/**
	 * `impact`: the issues building the flow a breaking version reaches, once `brokenBy` names one:
	 * each issue whose build link names this design, and each whose live criteria trace a BC of
	 * this requirement, which pins the broken version; a dropped issue builds nothing. Empty while
	 * nothing broke the element.
	 */
	buildingIssues: RequirementBuildingIssue[];
}

/** An issue building the flow a broken screen binding sits in. */
export interface RequirementBuildingIssue {
	issueId: string;
	displayId: string;
	title: string;
	status: string;
}

/** `PUT /api/projects/:id/requirement-areas`: the whole list of the project's areas, in order. */
export const requirementAreasRequestSchema = z.strictObject({
	names: z.array(z.string().trim().min(1).max(60)).max(30),
});
export const REQUIREMENT_AREAS_SHAPE =
	"{ names: string[] } the project's areas, in the order a list draws them";

/** `PUT …/requirements/:req/placement`: set the area and short name; a field left out stays, null clears it. */
export const requirementPlacementRequestSchema = z
	.strictObject({
		areaId: z.uuid().nullable().optional(),
		shortName: z.string().trim().min(1).max(80).nullable().optional(),
	})
	// a body naming neither field changes nothing, so it is refused rather than answered 200
	.refine((b) => b.areaId !== undefined || b.shortName !== undefined, {
		message: "name areaId, shortName or both",
	});
export const REQUIREMENT_PLACEMENT_SHAPE =
	"{ areaId?: uuid | null, shortName?: string (at most 6 words) | null }, at least one of them";

/** `PATCH …/requirements/:req`: name the requirement's owner, a member of the project, or null for none. */
export const patchRequirementRequestSchema = z.strictObject({
	owner: z.uuid().nullable(),
});
export const PATCH_REQUIREMENT_SHAPE =
	"{ owner: uuid | null } the user id of a project member who owns the requirement, or null for none";
