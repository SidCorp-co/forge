import type { FeedbackPhase } from "./feedback.js";
import type {
	IssueAttentionGroup,
	IssueWaitingKind,
} from "./issue-standing.js";
import type { IssueStatus } from "./issue-machine.js";
import type { IssueStatusTone, WorkStep } from "./issue-vocabulary.js";
import type {
	Standing,
	StandingGroup,
	StandingGroupLabels,
	WaitingOn,
} from "./standing.js";

export const MODULE_ATTENTION_GROUPS = [
	"needs_you",
	"moving",
	"stuck",
	"quiet",
] as const satisfies readonly StandingGroup[];
export type ModuleAttentionGroup = (typeof MODULE_ATTENTION_GROUPS)[number];

export const MODULE_ATTENTION_LABELS: StandingGroupLabels<ModuleAttentionGroup> = {
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

/** `waitingOn` is the standing of `leadIssue`, the issue that leads the module's group. */
export interface ModuleStanding
	extends Standing<ModuleAttentionGroup, IssueWaitingKind> {
	leadIssue: string | null;
	open: number;
	openByKind: Record<ModuleOpenKind, number>;
	running: number;
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

/**
 * A coupling between two sibling modules (children of `parentId`, or roots when it is null), rolled
 * up from every pair of modules beneath them. `sharedIssues` counts distinct unarchived issues
 * carrying a module from each side.
 */
export interface ModuleLevelCoupling {
	parentId: string | null;
	aId: string;
	bId: string;
	sharedIssues: number;
	weight: number;
}

export interface ModuleRollupResponse {
	activeWithinDays: number;
	generatedAt: string;
	modules: ModuleRollupRow[];
	couplings: ModuleLevelCoupling[];
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

/** A module attributed to the same issues as this one. */
export interface ModuleCoupling {
	module: ModuleRef;
	issueCount: number;
	recentIssueKeys: string[];
}

export interface ModuleActivityDay {
	date: string;
	events: number;
}

export interface ModuleActiveIssue {
	key: string;
	title: string;
	status: IssueStatus;
	tone: IssueStatusTone;
	step: WorkStep | null;
	attentionGroup: IssueAttentionGroup;
	waitingOn: WaitingOn<IssueWaitingKind>;
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
	couplings: ModuleCoupling[];
	landings: { total: number; recent: ModuleLanding[] };
	activity: { days: ModuleActivityDay[]; total: number };
	issues: ModuleActiveIssue[];
	feedback: ModuleFeedbackRef[];
	contracts: ModuleUnavailable;
	owner: ModuleUnavailable;
	issuesRead: ModuleIssuesRead;
}

/** Where a traced unit lives: a core module, a web-v2 feature directory or a runner crate. */
export const CODE_TRACE_SCOPES = ["core", "web", "runner"] as const;
export type CodeTraceScope = (typeof CODE_TRACE_SCOPES)[number];

/**
 * One unit of the build's requirement trace (packages/core/src/modules.json `serves`): the
 * requirement keys, workflow steps (`<workflow>#<step>`) and `via:<unit>` it serves.
 */
export interface CodeTraceUnit {
	scope: CodeTraceScope;
	unit: string;
	serves: string[];
}

export interface CodeTraceResponse {
	units: CodeTraceUnit[];
	total: number;
	/** Units whose `serves` is empty. */
	untraced: number;
}
