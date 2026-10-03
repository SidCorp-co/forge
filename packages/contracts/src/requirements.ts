// Where a requirement stands — the read model core derives in `requirements/standing.ts` and every
// requirement surface draws: the attention group it is listed under, whom it waits on, the facts that
// decide it, and the coverage of each business criterion. Core writes the shapes; web-v2 reads the
// labels, so one value keeps one badge on every screen.

import type { IssueStatusTone } from "./issue-vocabulary.js";

/** The lifecycle a person reads: the stored status (draft, agreed, accepted, dropped) with agreed
 *  split by the derived delivery phase. `dropped` is off the line. */
export const REQUIREMENT_LIFECYCLE = [
	"draft",
	"agreed",
	"in_delivery",
	"delivered",
	"accepted",
] as const;
export const REQUIREMENT_STATES = [
	...REQUIREMENT_LIFECYCLE,
	"dropped",
] as const;
export type RequirementState = (typeof REQUIREMENT_STATES)[number];

/** The issue badge legend's tones, so a requirement's colours mean what an issue's do. */
export type StandingTone = IssueStatusTone;

export const REQUIREMENT_STATE_LABELS: Record<RequirementState, string> = {
	draft: "Draft",
	agreed: "Agreed",
	in_delivery: "In delivery",
	delivered: "Delivered",
	accepted: "Accepted",
	dropped: "Dropped",
};

export const REQUIREMENT_STATE_TONES: Record<RequirementState, StandingTone> = {
	draft: "neutral",
	agreed: "ready",
	in_delivery: "run",
	delivered: "you",
	accepted: "done",
	dropped: "done",
};

export const REQUIREMENT_STATE_GLYPHS: Record<RequirementState, string> = {
	draft: "○",
	agreed: "◆",
	in_delivery: "●",
	delivered: "✓",
	accepted: "✓",
	dropped: "×",
};

export const REQUIREMENT_STATE_HINTS: Record<RequirementState, string> = {
	draft: "draft: being written, not agreed; nothing is built against it",
	agreed: "agreed: a person agreed a revision; no linked issue has started",
	in_delivery: "in_delivery: a linked issue has started",
	delivered:
		"delivered: every linked issue is closed; a person accepts the delivery",
	accepted: "accepted: delivered and accepted",
	dropped: "dropped: no longer wanted",
};

/** The list's attention groups, in the order they are drawn. */
export const REQUIREMENT_ATTENTION_GROUPS = [
	"needs_you",
	"moving",
	"others",
	"stuck",
	"done",
] as const;
export type RequirementAttentionGroup =
	(typeof REQUIREMENT_ATTENTION_GROUPS)[number];

export const REQUIREMENT_ATTENTION_LABELS: Record<
	RequirementAttentionGroup,
	{ label: string; hint: string | null; tone: StandingTone; collapsed: boolean }
> = {
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
	others: {
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
	done: { label: "Done", hint: null, tone: "done", collapsed: true },
};

/** Whom a requirement waits on: the viewer, another person, an agent (the master, a draft's agent
 *  author), its issues, or nobody (done, or no owner to act). */
export const WAITING_ON_KINDS = [
	"you",
	"person",
	"agent",
	"issues",
	"none",
] as const;
export type WaitingOnKind = (typeof WAITING_ON_KINDS)[number];

export interface RequirementWaitingOn {
	kind: WaitingOnKind;
	/** Sentence-case name: "You", "Minh", "Master", "BA or owner", "No owner". */
	who: string;
	/** What they owe, lower-case after the name: "accept r2", "break down", "Running 2 of 5". */
	act: string;
	/** Why, for the tooltip: the rule in `requirements/standing.ts` that put it there. */
	rule: string;
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
	/** Designs the latest baseline pins at an older revision than the one now approved. */
	stalePins: { flow: string; pinned: number; approved: number }[];
}

export interface CoverageIssue {
	issueId: string;
	displayId: string;
	title: string;
	status: string;
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

export interface RequirementStanding {
	state: RequirementState;
	attentionGroup: RequirementAttentionGroup;
	waitingOn: RequirementWaitingOn;
	facts: RequirementFacts;
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
