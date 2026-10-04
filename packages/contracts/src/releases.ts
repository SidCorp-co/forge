// cm:why one declaration of the release read model (REQ-11 BC-6, BC-12, ISS-71): core derives every
// fact in `release-batch/release-view.ts` and `release-batch/versions.ts`, and the Releases list,
// peek and page draw them, so a state keeps one badge and nobody derives whom a release waits on in
// the browser.

import type { CriterionStanding, IssueStatusTone } from "./issue-vocabulary.js";
import type { BcVerdict, RequirementState } from "./requirements.js";

export const VERSION_STATUSES = [
	"in_progress",
	"awaiting_approval",
	"returned",
	"shipped",
	"rolled_back",
	"failed",
	"aborted",
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const RELEASE_STATES = ["draft", ...VERSION_STATUSES] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

export const RELEASE_STATE_LABELS: Record<ReleaseState, string> = {
	draft: "Draft",
	in_progress: "In progress",
	awaiting_approval: "Awaiting approval",
	returned: "Returned",
	shipped: "Shipped",
	rolled_back: "Rolled back",
	failed: "Failed",
	aborted: "Aborted",
};

export const RELEASE_STATE_TONES: Record<ReleaseState, IssueStatusTone> = {
	draft: "neutral",
	in_progress: "run",
	awaiting_approval: "you",
	returned: "err",
	shipped: "ready",
	rolled_back: "err",
	failed: "err",
	aborted: "neutral",
};

export const RELEASE_STATE_GLYPHS: Record<ReleaseState, string> = {
	draft: "○",
	in_progress: "●",
	awaiting_approval: "↑",
	returned: "↺",
	shipped: "✓",
	rolled_back: "↺",
	failed: "×",
	aborted: "–",
};

export const RELEASE_STATE_HINTS: Record<ReleaseState, string> = {
	draft:
		"draft: merged issues wait at the release gate and no version holds them yet",
	in_progress:
		"in_progress: a release run is promoting, deploying or verifying the version",
	awaiting_approval:
		"awaiting_approval: no production act is taken until an admin approves",
	returned:
		"returned: an admin sent it back with a reason; the master answers before it asks again",
	shipped: "shipped: the release run stamped the version released",
	rolled_back:
		"rolled_back: production was repaired back to the previous version",
	failed: "failed: the release run ended without shipping",
	aborted: "aborted: the release run was stopped on purpose",
};

export const RELEASE_ATTENTION = [
	"you",
	"moving",
	"others",
	"stuck",
	"done",
	"stopped",
] as const;
export type ReleaseAttention = (typeof RELEASE_ATTENTION)[number];

export const RELEASE_ATTENTION_LABELS: Record<
	ReleaseAttention,
	{ label: string; hint: string; tone: IssueStatusTone; collapsed: boolean }
> = {
	you: {
		label: "Needs you",
		hint: "Approve or return a release, or cut the next one",
		tone: "you",
		collapsed: false,
	},
	moving: {
		label: "Moving",
		hint: "A release run is working on production",
		tone: "run",
		collapsed: false,
	},
	others: {
		label: "Someone else’s turn",
		hint: "The master or another approver acts next",
		tone: "neutral",
		collapsed: false,
	},
	stuck: {
		label: "Stuck",
		hint: "A gate holds the draft, or a run crossed a bound",
		tone: "err",
		collapsed: false,
	},
	done: {
		label: "Shipped",
		hint: "Live, or superseded by a later release",
		tone: "done",
		collapsed: false,
	},
	stopped: {
		label: "Stopped",
		hint: "Ended without shipping: failed, rolled back or aborted",
		tone: "neutral",
		collapsed: true,
	},
};

export const RELEASE_WAITING_KINDS = [
	"you",
	"person",
	"agent",
	"system",
	"none",
] as const;
export type ReleaseWaitingKind = (typeof RELEASE_WAITING_KINDS)[number];

export interface ReleaseWaiting {
	kind: ReleaseWaitingKind;
	who: string;
	act: string;
	rule: string;
}

export interface ReleasePerson {
	id: string;
	name: string;
	kind: "human" | "agent";
}

export const RELEASE_PROOFS = [
	"proven",
	"failing",
	"open",
	"unrecorded",
] as const;
export type ReleaseProof = (typeof RELEASE_PROOFS)[number];

export const RELEASE_PROOF_LABELS: Record<ReleaseProof, string> = {
	proven: "Proven",
	failing: "Failing",
	open: "Not judged yet",
	unrecorded: "No criteria recorded",
};

export const RELEASE_PROOF_TONES: Record<ReleaseProof, IssueStatusTone> = {
	proven: "ready",
	failing: "err",
	open: "neutral",
	unrecorded: "neutral",
};

export interface ReleaseCriteriaTotals {
	proven: number;
	failing: number;
	open: number;
	total: number;
}

export interface ReleaseContentIssue {
	key: string;
	title: string;
	status: string;
	proof: ReleaseProof;
}

export interface ReleaseContentGroup {
	requirement: { key: string; title: string } | null;
	issues: ReleaseContentIssue[];
}

export interface ReleaseSummary {
	key: string;
	version: string;
	runId: string | null;
	state: ReleaseState;
	current: boolean;
	attention: ReleaseAttention;
	waiting: ReleaseWaiting;
	headline: string;
	issueCount: number;
	requirements: string[];
	criteria: ReleaseCriteriaTotals;
	contents: ReleaseContentGroup[];
	owner: ReleasePerson | null;
	ownerAct: string | null;
	can: { cut: boolean; decide: boolean };
	openedAt: string | null;
	releasedAt: string | null;
	at: string;
}

export type ReleaseProduction =
	| {
			ok: true;
			name: string | null;
			url: string | null;
			serving: string | null;
	  }
	| { ok: false; reason: string };

export interface ReleaseListResponse {
	releases: ReleaseSummary[];
	counts: Record<ReleaseAttention, number>;
	approvalRequired: boolean;
	production: ReleaseProduction;
}

export interface ReleaseIssueView {
	id: string;
	key: string;
	title: string;
	status: string;
	section: string | null;
	requirement: string | null;
	proof: ReleaseProof;
	criteria: ReleaseCriteriaTotals;
	waiting: ReleaseWaiting;
}

export interface ReleaseRequirementView {
	key: string;
	title: string;
	state: RequirementState;
	completes: boolean;
	advances: { code: string; verdict: BcVerdict }[];
	remaining: { issues: string[]; criteria: string[] };
}

export interface ReleaseCriterionView {
	n: number;
	statement: string;
	standing: CriterionStanding;
	bc: string | null;
	identity: string | null;
	reason: string | null;
	judgedAt: string | null;
	judgedBy: "human" | "agent" | null;
}

export interface ReleaseIssueCriteria {
	key: string;
	title: string;
	criteria: ReleaseCriterionView[];
}

export interface ReleaseNoteEntry {
	key: string;
	userFacing: string;
	technical: string | null;
}

export interface ReleaseNoteSection {
	section: string;
	entries: ReleaseNoteEntry[];
}

export interface ReleaseGateView {
	code: string;
	kind: "blocker" | "warning";
	title: string;
	sentence: string;
	detail: string;
	issues: string[];
}

export interface ReleaseApprovalView {
	id: string;
	requestedBy: ReleasePerson;
	requestedAt: string;
	evidence: { environment: string; commit: string; reading: string };
	note: string | null;
	decision: "approved" | "returned" | null;
	decidedBy: ReleasePerson | null;
	decidedAt: string | null;
	reason: string | null;
}

export const RELEASE_ATTEMPT_STAGES = [
	"promote",
	"deploy",
	"verify",
	"repair",
] as const;
export type ReleaseAttemptStage = (typeof RELEASE_ATTEMPT_STAGES)[number];

export interface ReleaseAttemptView {
	id: string;
	stage: ReleaseAttemptStage;
	verdict: "ok" | "failed" | "unverified" | null;
	health: "up" | "down" | null;
	commit: string | null;
	providerRef: string | null;
	identity: string | null;
	readings: string[];
	verdictReason: string | null;
	account: string | null;
	logTail: string | null;
	logTailTruncated: boolean;
	logTailReadBy: string | null;
	logTailReadAt: string | null;
	startedAt: string;
	settledAt: string | null;
}

export interface ReleaseBoundView {
	name: "total" | "stall" | "regression";
	crossed: boolean;
	measuredMs: number | null;
	thresholdMs: number | null;
	why: string;
}

export interface ReleaseDetail extends ReleaseSummary {
	issues: ReleaseIssueView[];
	requirementsCompleted: ReleaseRequirementView[];
	issueCriteria: ReleaseIssueCriteria[];
	notes: {
		sections: ReleaseNoteSection[];
		withoutNotes: { key: string; title: string }[];
	};
	gates: ReleaseGateView[];
	approval: ReleaseApprovalView | null;
	approvals: ReleaseApprovalView[];
	approvers: ReleasePerson[];
	approvalRequired: boolean;
	attempts: ReleaseAttemptView[];
	bounds: { holding: boolean; bounds: ReleaseBoundView[] };
	production: { name: string | null; url: string | null } | null;
	head: string | null;
}

export interface ReleaseResponse {
	release: ReleaseDetail;
}

/** Every reason a release will not start, in the order the doors refuse in (ISS-1127). */
export const RELEASE_BLOCKER_CODES = [
	"NO_RELEASE_GATE",
	"RELEASE_TARGET_UNDECLARED",
	"CLAIM_CONFLICT",
	"RELEASE_ROSTER_EMPTY",
	"RELEASE_ROSTER_OVERSIZE",
	"RELEASE_RECORD_MISSING",
	"RELEASE_WORK_UNMERGED",
	"CONTRACT_PROVIDER_NOT_LIVE",
	"RELEASE_PROBES_UNREADABLE",
	"RELEASE_POOL_EMPTY",
	"NO_RUNNER_ONLINE",
	"BATCH_IN_FLIGHT",
	"RELEASE_CRITERIA_UNEARNED",
	"RELEASE_RUNTIME_UNROUTED",
	"RELEASE_CHECK_UNEVALUATED",
] as const;
export type ReleaseBlockerCode = (typeof RELEASE_BLOCKER_CODES)[number];

export const RELEASE_APPROVAL_REFUSAL_CODES = [
	"RELEASE_APPROVAL_SHAPE",
	"RELEASE_APPROVAL_PENDING",
	"RELEASE_APPROVAL_NOT_PENDING",
	"RELEASE_APPROVAL_EVIDENCE_ENVIRONMENT",
	"RELEASE_APPROVAL_PATH_UNREADABLE",
	"RELEASE_RUN_CONCLUDED",
	"RELEASE_DECISION_UNKNOWN",
	"RELEASE_RETURN_WITHOUT_REASON",
	"RELEASE_AWAITING_APPROVAL",
	"RELEASE_APPROVAL_RETURNED",
	"RELEASE_APPROVAL_REQUIRED",
	"RELEASE_VERSION_SHAPE",
] as const;
export type ReleaseApprovalRefusalCode = (typeof RELEASE_APPROVAL_REFUSAL_CODES)[number];

/** Every code a release door refuses with, in the one 422 envelope; `RELEASE_REFUSED` when several differ. */
export const RELEASE_REFUSAL_CODES = [
	"RELEASE_REFUSED",
	...RELEASE_BLOCKER_CODES,
	...RELEASE_APPROVAL_REFUSAL_CODES,
	"RELEASE_ISSUES_UNNAMED",
	"RELEASE_VERDICT_NOT_YOURS",
	"RELEASE_NOT_VERIFIED",
	"RELEASE_BATCH_ABORTED",
	"RELEASE_FINISH_IN_FLIGHT",
	"RELEASE_FINISHED_FOR_OTHER_COMMIT",
	"RELEASE_CLAIM_LOST",
	"RELEASE_FINISH_LEASE_LOST",
	"RELEASE_VERSION_MISSING",
	"RELEASE_VERSION_CONFLICT",
	"RELEASE_RECUT_REFUSED",
	"RELEASE_VERSION_EXHAUSTED",
	"RELEASE_VERSION_LINE_BEHIND",
	"RELEASE_RUN_HOLDING",
	"RELEASE_RUN_NOT_OPEN",
	"RELEASE_NOTHING_RECORDED",
] as const;
export type ReleaseRefusalCode = (typeof RELEASE_REFUSAL_CODES)[number];
