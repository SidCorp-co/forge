// one declaration of the automation read model (design automation rev 1, steps streak, settle,
// needs_you and wait_triage; ISS-114): core derives every value below from the rows that own it, and
// the web, MCP and the needs-you count read it, so no screen derives a schedule state of its own

import type { Said } from "./said.js";
import type { AgentReportTriage, AgentReportView } from "./agent-reports.js";
import type {
	ScheduleRunSkipReason,
	ScheduleRunStatus,
	ScheduleRunTrigger,
} from "./schedules.js";
import type {
	Standing,
	StandingGroup,
	StandingGroupLabels,
	WaitingKind,
} from "./standing.js";

export const SCHEDULE_STATES = [
	"on",
	"off",
	"failing",
	"owner_gone",
	"firing",
] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

/** What a person owes automation, as needs-you names it (design automation rev 1, step needs_you). */
export const AUTOMATION_ACTS = [
	"triage_report",
	"fix_schedule",
	"reassign_owner",
] as const;
export type AutomationAct = (typeof AUTOMATION_ACTS)[number];

/** Whom a schedule, fire or report waits on: the viewer, its owner, the admins or writers, where a
 *  filed report went, or nobody. `act` is the owed act's words (core `automation/standing.ts:ACT_SAID`). */
export const AUTOMATION_WAITING_KINDS = [
	"you",
	"person",
	"admins",
	"writers",
	"issue",
	"feedback",
	"none",
] as const satisfies readonly WaitingKind[];
export type AutomationWaitingKind = (typeof AUTOMATION_WAITING_KINDS)[number];

/** The list groups, Needs you first; `waiting` holds what waits on a person who is not the viewer. */
export const SCHEDULE_GROUPS = [
	"needs_you",
	"waiting",
	"on",
	"off",
] as const satisfies readonly StandingGroup[];
export type ScheduleGroup = (typeof SCHEDULE_GROUPS)[number];

export const FIRE_GROUPS = [
	"needs_you",
	"running",
	"produced",
	"nothing_produced",
	"failed_or_skipped",
] as const satisfies readonly StandingGroup[];
export type FireGroup = (typeof FIRE_GROUPS)[number];

export const REPORT_GROUPS = [
	"needs_you",
	"waiting",
	"filed",
	"closed",
] as const satisfies readonly StandingGroup[];
export type ReportGroup = (typeof REPORT_GROUPS)[number];

export const SCHEDULE_GROUP_LABELS: StandingGroupLabels<ScheduleGroup> = {
	needs_you: {
		label: "Needs you",
		hint: "Failing, or the account it runs as is gone",
		tone: "you",
		collapsed: false,
	},
	waiting: {
		label: "Waiting on someone else",
		hint: "Its owner or an admin owes the fix",
		tone: "blocked",
		collapsed: false,
	},
	on: { label: "On", hint: "", tone: "ready", collapsed: false },
	off: {
		label: "Off",
		hint: "Paused; never claimed",
		tone: "done",
		collapsed: true,
	},
};

export const FIRE_GROUP_LABELS: StandingGroupLabels<FireGroup> = {
	needs_you: {
		label: "Needs you",
		hint: "Its reports wait for triage, or its schedule is failing",
		tone: "you",
		collapsed: false,
	},
	running: { label: "Running", hint: "", tone: "run", collapsed: false },
	produced: {
		label: "Produced something",
		hint: "",
		tone: "ready",
		collapsed: false,
	},
	nothing_produced: {
		label: "Nothing produced",
		hint: "",
		tone: "neutral",
		collapsed: false,
	},
	failed_or_skipped: {
		label: "Failed or skipped",
		hint: "",
		tone: "err",
		collapsed: true,
	},
};

export const REPORT_GROUP_LABELS: StandingGroupLabels<ReportGroup> = {
	needs_you: {
		label: "Needs you",
		hint: "New, high severity first, then oldest",
		tone: "you",
		collapsed: false,
	},
	waiting: {
		label: "Waiting for triage",
		hint: "New: a fire's report owed by its schedule owner, or an issue run's report on the harness it worked under",
		tone: "blocked",
		collapsed: false,
	},
	filed: { label: "Filed", hint: "", tone: "ready", collapsed: false },
	closed: {
		label: "Dismissed or duplicate",
		hint: "",
		tone: "done",
		collapsed: true,
	},
};

export const AUTOMATION_FIRES_DEFAULT = 50;
export const AUTOMATION_FIRES_MAX = 200;
/** Every report at triage new is served; of the triaged ones, the newest this many. */
export const AUTOMATION_TRIAGED_REPORTS = 50;

export interface AutomationPerson {
	id: string;
	name: string | null;
}

export interface ScheduleLastFire {
	id: string;
	status: ScheduleRunStatus;
	trigger: ScheduleRunTrigger;
	startedAt: string;
	finishedAt: string | null;
	reason: ScheduleRunSkipReason | null;
	refusal: string | null;
	/** The session a prompt fire started; null for a fire that ran none. */
	sessionId: string | null;
}

export interface ScheduleStanding
	extends Standing<ScheduleGroup, AutomationWaitingKind> {
	id: string;
	projectId: string;
	name: string;
	kind: string;
	cron: string;
	enabled: boolean;
	targetProjectSlug: string | null;
	state: ScheduleState;
	/** Why the schedule stands where it does, for the tooltip. */
	rule: string;
	/** `rule` as said (`said.ts`). */
	says: { rule: Said };
	/** When the ticker claims it next; null while it is off. */
	nextFireAt: string | null;
	/** Whom a prompt fire runs as; null once that account is gone. */
	owner: AutomationPerson | null;
	/** Trailing failed fires, a no-device or project-not-found skip counted and the others not (alert A5's rule). */
	streak: number;
	lastFire: ScheduleLastFire | null;
	/** What the viewer may do: edit it (pause and fix included), and take it over when it is not theirs. */
	viewerMay: { edit: boolean; takeOver: boolean };
	createdAt: string;
}

/** What a fire produced, each counted by its join to the fire, never by a stored total. */
export interface FireProduced {
	reports: number;
	/** Of those, the ones still at triage new. */
	newReports: number;
	/** Steward actions proposed or applied, read through the fire's session. */
	proposals: number;
	issues: number;
	/** The run a runner-less fire started (a release cut); a prompt fire's own run is not counted. */
	runs: number;
	notifications: number;
}

export interface FireStanding
	extends Standing<FireGroup, AutomationWaitingKind> {
	id: string;
	scheduleId: string;
	scheduleName: string;
	trigger: ScheduleRunTrigger;
	status: ScheduleRunStatus;
	reason: ScheduleRunSkipReason | null;
	refusal: string | null;
	error: string | null;
	disposition: string | null;
	sessionId: string | null;
	pipelineRunId: string | null;
	startedAt: string;
	finishedAt: string | null;
	durationSeconds: number | null;
	produced: FireProduced;
}

export interface ReportFireRef {
	id: string;
	scheduleId: string;
	scheduleName: string;
}

export interface ReportStanding
	extends AgentReportView,
		Standing<ReportGroup, AutomationWaitingKind> {
	fire: ReportFireRef | null;
}

export interface FireProposal {
	fireId: string;
	scheduleId: string;
	scheduleName: string;
	sessionId: string;
	skill: string;
	kind: "proposed" | "applied";
	summary: string;
	at: string;
}

export interface AutomationStandingResponse {
	generatedAt: string;
	/** scheduleFailStreak, the threshold failing is read against. */
	failStreak: number;
	schedules: ScheduleStanding[];
	fires: FireStanding[];
	firesTotal: number;
	firesHasMore: boolean;
	reports: ReportStanding[];
	reportCounts: Record<AgentReportTriage, number>;
	/** The proposals of the fires served, newest first. */
	proposals: FireProposal[];
}

export interface FireProducedItems {
	reports: Array<{
		id: string;
		summary: string;
		kind: string;
		severity: string;
		triage: AgentReportTriage;
	}>;
	proposals: FireProposal[];
	issues: Array<{ id: string; key: string; title: string; status: string }>;
	runs: Array<{ id: string; kind: string; status: string }>;
	notifications: Array<{
		id: string;
		type: string;
		title: string;
		createdAt: string;
	}>;
}

export interface FireDetailResponse {
	fire: FireStanding & { output: string | null };
	schedule: ScheduleStanding;
	produced: FireProducedItems;
}

export interface ReportDetailResponse {
	report: ReportStanding;
}

export interface ScheduleDetailResponse {
	schedule: ScheduleStanding;
	fires: Array<FireStanding & { output: string | null }>;
	firesTotal: number;
	firesHasMore: boolean;
	/** Every report this schedule's fires filed. */
	reports: ReportStanding[];
	proposals: FireProposal[];
}
