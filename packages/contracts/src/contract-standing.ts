// cm:why the Contracts list and a contract's full page read one core model
// (`GET /api/projects/:id/contract-standing`, ISS-70): attention, whom it waits on, the commitment
// window, adoption and the issues waiting on a version are core's, never the browser's (REQ-11 BC-12)

import type { FeedbackStatus } from "./feedback.js";
import type { IssueStatus } from "./issue-machine.js";
import type { IssueStatusTone } from "./issue-vocabulary.js";
import type {
	Standing,
	StandingGroup,
	StandingGroupLabels,
	WaitingKind,
} from "./standing.js";

export const CONTRACT_DIRECTIONS = ["provided", "consumed"] as const;
export type ContractDirection = (typeof CONTRACT_DIRECTIONS)[number];

export const CONTRACT_DIRECTION_LABELS: Record<ContractDirection, string> = {
	provided: "Provided",
	consumed: "Consumed",
};

export const CONTRACT_ATTENTION_GROUPS = [
	"needs_you",
	"waiting",
	"steady",
] as const satisfies readonly StandingGroup[];
export type ContractAttentionGroup = (typeof CONTRACT_ATTENTION_GROUPS)[number];

export const CONTRACT_ATTENTION_LABELS: StandingGroupLabels<ContractAttentionGroup> = {
	needs_you: {
		label: "Needs you",
		hint: "A breaking version to adapt to before its window ends, a version to decide, or a request to reply to",
		tone: "you",
		collapsed: false,
	},
	waiting: {
		label: "Waiting on others",
		hint: "An issue here waits on a version not yet published, a request waits on its provider, or consumers have not adopted a breaking version",
		tone: "blocked",
		collapsed: false,
	},
	steady: {
		label: "Steady",
		hint: "Nothing is owed on it by anyone",
		tone: "done",
		collapsed: false,
	},
};

export const CONTRACT_STATES = [
	"unpublished",
	"proposed",
	"breaking_pending",
	"behind",
	"published",
	"deprecated",
] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

export const CONTRACT_STATE_LABELS: Record<ContractState, string> = {
	unpublished: "Not published",
	proposed: "Awaiting approval",
	breaking_pending: "Breaking pending",
	behind: "Behind",
	published: "Published",
	deprecated: "Deprecated",
};

export const CONTRACT_STATE_TONES: Record<ContractState, IssueStatusTone> = {
	unpublished: "neutral",
	proposed: "you",
	breaking_pending: "you",
	behind: "blocked",
	published: "done",
	deprecated: "done",
};

export const CONTRACT_STATE_GLYPHS: Record<ContractState, string> = {
	unpublished: "○",
	proposed: "●",
	breaking_pending: "⏳",
	behind: "!",
	published: "✓",
	deprecated: "⊘",
};

export const CONTRACT_STATE_HINTS: Record<ContractState, string> = {
	unpublished: "unpublished: declared in the interface document, with no approved version",
	proposed: "proposed: a recorded version waits on its approver",
	breaking_pending: "breaking_pending: a breaking version is approved and its commitment window is counting down",
	behind: "behind: this project is built against an older version than the provider's current one",
	published: "published: an approved version is current",
	deprecated: "deprecated: the provider takes no new consumers on it",
};

export const CONTRACT_ADOPTIONS = ["current", "owes", "behind", "unpublished"] as const;
export type ContractAdoption = (typeof CONTRACT_ADOPTIONS)[number];

export const CONTRACT_ADOPTION_LABELS: Record<ContractAdoption, string> = {
	current: "On latest",
	owes: "Must adapt",
	behind: "Behind",
	unpublished: "No version",
};

export const CONTRACT_ADOPTION_TONES: Record<ContractAdoption, IssueStatusTone> = {
	current: "ready",
	owes: "you",
	behind: "blocked",
	unpublished: "neutral",
};

export const CONTRACT_ADOPTION_GLYPHS: Record<ContractAdoption, string> = {
	current: "✓",
	owes: "⏳",
	behind: "!",
	unpublished: "○",
};

export const CONTRACT_ADOPTION_HINTS: Record<ContractAdoption, string> = {
	current: "current: built against the provider's current version",
	owes: "owes: on an older version while a breaking version's window is open",
	behind: "behind: built against an older version than the current one",
	unpublished: "unpublished: the provider has approved no version yet",
};

export const CONTRACT_APPROVAL_LABELS: Record<string, string> = {
	proposed: "Awaiting approval",
	approved: "Approved",
	returned: "Returned",
};

export const CONTRACT_APPROVAL_TONES: Record<string, IssueStatusTone> = {
	proposed: "you",
	approved: "ready",
	returned: "err",
};

export const CONTRACT_WAITING_KINDS = [
	"you",
	"person",
	"project",
	"none",
] as const satisfies readonly WaitingKind[];
export type ContractWaitingKind = (typeof CONTRACT_WAITING_KINDS)[number];

export interface ContractProjectRef {
	id: string;
	slug: string;
	name: string;
}

export interface ContractVersionRef {
	version: string;
	recordedAt: string;
	classification: string;
	approval: string;
	decidedAt: string | null;
}

export interface ContractWindow {
	version: string;
	dueAt: string;
	open: boolean;
}

export interface ContractStandingRow
	extends Standing<ContractAttentionGroup, ContractWaitingKind> {
	ref: string;
	slug: string;
	provider: ContractProjectRef;
	direction: ContractDirection;
	title: string;
	summary: string | null;
	kind: string;
	lifecycle: string;
	current: ContractVersionRef | null;
	pending: ContractVersionRef | null;
	ours: string | null;
	window: ContractWindow | null;
	noticeDays: number | null;
	consumers: { total: number; current: number; behind: number };
	waits: number;
	openRequests: number;
	state: ContractState;
	touchedAt: string | null;
}

export interface ContractStandingList {
	generatedAt: string;
	project: ContractProjectRef;
	declared: boolean;
	contracts: ContractStandingRow[];
}

export interface ContractChangeView {
	element: string;
	kind: string;
	level: string;
	text: string;
}

export interface ContractVersionView extends ContractVersionRef {
	previous: string | null;
	changes: ContractChangeView[];
	decisionReason: string | null;
}

export interface ContractConsumerView {
	project: ContractProjectRef;
	builtAgainst: string;
	adoption: ContractAdoption;
	self: boolean;
}

export interface ContractIssueWait {
	issue: string;
	title: string;
	status: IssueStatus;
	minVersion: string;
	reason: string | null;
	settled: boolean;
}

export interface ContractDemand {
	project: ContractProjectRef;
	issues: number;
	minVersions: string[];
}

export interface ContractRequestRow {
	number: string;
	direction: "incoming" | "outgoing";
	counterpart: ContractProjectRef;
	requirement: { key: string; title: string; status: string; project: string };
	open: boolean;
	createdAt: string;
}

export interface ContractFeedbackRef {
	key: string;
	title: string;
	status: FeedbackStatus;
	version: string;
	dueAt: string | null;
}

export interface ContractMeasurementView {
	outcome: string;
	version: string | null;
	environments: string[];
	branch: string;
	commit: string;
	observedAt: string;
	reason: string | null;
}

export interface ContractUnavailable {
	available: false;
	reason: string;
}

export const CONTRACT_MEASUREMENTS_SHOWN = 10;

export interface ContractStandingDetail {
	generatedAt: string;
	project: ContractProjectRef;
	contract: ContractStandingRow;
	versions: ContractVersionView[];
	consumers: ContractConsumerView[];
	waits: ContractIssueWait[];
	demand: ContractDemand[];
	requests: ContractRequestRow[];
	feedback: ContractFeedbackRef[];
	measurements: ContractMeasurementView[] | null;
	module: ContractUnavailable;
}
