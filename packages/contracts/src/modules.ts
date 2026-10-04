import type { FeedbackPhase } from "./feedback.js";
import type {
	IssueAttentionGroup,
	IssueWaitingOn,
} from "./issue-standing.js";
import type {
	IssueStatusTone,
	KernelIssueStatus,
	WorkStep,
} from "./issue-vocabulary.js";

export const MODULE_ATTENTION_GROUPS = [
	"needs_you",
	"moving",
	"stuck",
	"quiet",
] as const;
export type ModuleAttentionGroup = (typeof MODULE_ATTENTION_GROUPS)[number];

export const MODULE_ATTENTION_LABELS: Record<
	ModuleAttentionGroup,
	{ label: string; hint: string; tone: IssueStatusTone; collapsed: boolean }
> = {
	needs_you: {
		label: "Needs you",
		hint: "An issue in it waits on you to answer, decide or approve",
		tone: "you",
		collapsed: false,
	},
	moving: {
		label: "Moving",
		hint: "A run holds a live lease on one of its issues",
		tone: "run",
		collapsed: false,
	},
	stuck: {
		label: "Stuck",
		hint: "An issue in it waits on another issue, has no live holder, or came back",
		tone: "blocked",
		collapsed: false,
	},
	quiet: {
		label: "Quiet",
		hint: "Nothing in it needs anyone and nothing is running",
		tone: "done",
		collapsed: true,
	},
};

export const MODULE_OPEN_KINDS = [
	"needs_you",
	"moving",
	"stuck",
	"queued",
	"paused",
] as const satisfies readonly IssueAttentionGroup[];
export type ModuleOpenKind = (typeof MODULE_OPEN_KINDS)[number];

export const MODULE_ACTIVITY_DAYS = 14;
export const MODULE_LANDINGS_SHOWN = 10;
export const MODULE_KEY_PATHS_SHOWN = 12;
export const MODULE_BODY_LIMIT = 24000;

export interface ModuleCounts {
	total: number;
	open: number;
	closed: number;
	dropped: number;
	recentlyActive: number;
}

export interface ModuleAttributionCounts {
	primary: ModuleCounts;
	secondary: ModuleCounts;
}

export interface ModuleRef {
	id: string;
	slug: string;
	name: string;
	path: string;
}

export interface ModuleLanding {
	issueKey: string;
	title: string;
	landedAt: string;
	commitSha: string | null;
	target: string | null;
	landing: string | null;
	release: string | null;
	modulePath: string;
}

export interface ModuleRequirementTrace {
	key: string;
	title: string;
	criteria: string[];
}

export interface ModuleWaitingOn extends IssueWaitingOn {
	issueKey: string | null;
}

export interface ModuleStanding {
	attentionGroup: ModuleAttentionGroup;
	open: number;
	openByKind: Record<ModuleOpenKind, number>;
	running: number;
	waitingOn: ModuleWaitingOn;
	lastLanding: ModuleLanding | null;
	requirements: ModuleRequirementTrace[];
	childCount: number;
}

export interface ModuleRollupRow {
	id: string;
	name: string;
	slug: string | null;
	path: string;
	description: string | null;
	knowledgeEntryId: string | null;
	color: string;
	parentId: string | null;
	depth: number;
	own: ModuleAttributionCounts;
	inherited: ModuleAttributionCounts;
	rollup: ModuleAttributionCounts;
	standing: ModuleStanding;
}

export interface ModuleIssuesRead {
	returned: number;
	open: number;
}

export interface ModuleRollupResponse {
	activeWithinDays: number;
	generatedAt: string;
	modules: ModuleRollupRow[];
	unassigned: ModuleCounts;
	issuesRead: ModuleIssuesRead;
}

export type ModuleUnavailable = { available: false; reason: string };
export type ModuleFact<T> =
	| { available: true; value: T }
	| ModuleUnavailable;

export interface ModulePurpose {
	entrySlug: string;
	title: string;
	summary: string;
	body: string;
	bodyTruncated: boolean;
	updatedAt: string;
}

export const MODULE_COUPLING_SOURCES = ["declared", "issue_stream"] as const;
export type ModuleCouplingSource = (typeof MODULE_COUPLING_SOURCES)[number];

export interface ModuleCoupling {
	module: ModuleRef;
	source: ModuleCouplingSource;
	predicate: string | null;
	direction: "out" | "in" | null;
	issueCount: number | null;
	recentIssueKeys: string[];
}

export interface ModuleActivityDay {
	date: string;
	events: number;
}

export interface ModuleActiveIssue {
	key: string;
	title: string;
	status: KernelIssueStatus;
	tone: IssueStatusTone;
	step: WorkStep | null;
	attentionGroup: IssueAttentionGroup;
	waitingOn: IssueWaitingOn;
	modulePath: string;
}

export interface ModuleFeedbackRef {
	key: string;
	title: string;
	phase: FeedbackPhase;
}

export interface ModuleDetail {
	module: ModuleRef & {
		color: string;
		description: string | null;
		parent: ModuleRef | null;
		children: ModuleRef[];
	};
	standing: ModuleStanding;
	purpose: ModuleFact<ModulePurpose>;
	keyPaths: ModuleFact<string[]>;
	couplings: { declared: ModuleCoupling[]; observed: ModuleCoupling[] };
	landings: { total: number; recent: ModuleLanding[] };
	activity: { days: ModuleActivityDay[]; total: number };
	issues: ModuleActiveIssue[];
	feedback: ModuleFeedbackRef[];
	contracts: ModuleUnavailable;
	owner: ModuleUnavailable;
	issuesRead: ModuleIssuesRead;
}
