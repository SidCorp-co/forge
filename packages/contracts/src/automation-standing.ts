// cm:why one declaration of the automation read model (design automation rev 1, steps streak, settle,
// needs_you and wait_triage; ISS-114): core derives every value below from the rows that own it, and
// the web, MCP and the needs-you count read it, so no screen derives a schedule state of its own

import type { AgentReportTriage, AgentReportView } from "./agent-reports.js";
import type {
	ScheduleRunSkipReason,
	ScheduleRunStatus,
	ScheduleRunTrigger,
} from "./schedules.js";

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

/** How each act reads to a person, lower-case after "waiting on you". */
export const AUTOMATION_ACT_LABELS: Record<AutomationAct, string> = {
	triage_report: "triage a report",
	fix_schedule: "fix a failing schedule",
	reassign_owner: "take over a schedule whose owner is gone",
};

/** Whom a schedule, fire or report waits on: the viewer, its owner, the admins or writers, where a
 *  filed report went, or nobody. */
export const AUTOMATION_WAITING_KINDS = [
	"you",
	"person",
	"admins",
	"writers",
	"issue",
	"feedback",
	"none",
] as const;
export type AutomationWaitingKind = (typeof AUTOMATION_WAITING_KINDS)[number];

export interface AutomationWaitingOn {
	kind: AutomationWaitingKind;
	/** Sentence-case name: "You", "Minh", "A project admin", "A project writer", "ISS-12", "Nobody". */
	who: string;
	/** The act owed, when somebody owes one; null when nothing waits on a person. */
	act: AutomationAct | null;
	/** Why, for the tooltip: the rule in `automation/standing.ts` that put it there. */
	rule: string;
	/** The key `who` names when `kind` is issue or feedback; else null. */
	ref: string | null;
}

/** The list groups, Needs you first; `waiting` holds what waits on a person who is not the viewer. */
export const SCHEDULE_GROUPS = ["needs_you", "waiting", "on", "off"] as const;
export type ScheduleGroup = (typeof SCHEDULE_GROUPS)[number];

export const FIRE_GROUPS = [
	"needs_you",
	"running",
	"produced",
	"nothing_produced",
	"failed_or_skipped",
] as const;
export type FireGroup = (typeof FIRE_GROUPS)[number];

export const REPORT_GROUPS = [
	"needs_you",
	"waiting",
	"filed",
	"closed",
] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

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

export interface ScheduleStanding {
	id: string;
	projectId: string;
	name: string;
	kind: string;
	cron: string;
	enabled: boolean;
	templateKey: string | null;
	mode: string | null;
	targetProjectSlug: string | null;
	state: ScheduleState;
	/** Why the schedule stands where it does, for the tooltip. */
	rule: string;
	/** When the ticker claims it next; null while it is off. */
	nextFireAt: string | null;
	/** Whom a prompt fire runs as; null once that account is gone. */
	owner: AutomationPerson | null;
	/** Trailing failed fires, a no-device skip counted and already-applied not (alert A5's rule). */
	streak: number;
	lastFire: ScheduleLastFire | null;
	attentionGroup: ScheduleGroup;
	waitingOn: AutomationWaitingOn;
	createdAt: string;
}

/** What a fire produced, each counted by its join to the fire, never by a stored total. */
export interface FireProduced {
	/** agent_reports.schedule_run_id */
	reports: number;
	/** Of those, the ones still at triage new. */
	newReports: number;
	/** Steward actions proposed or applied, read through the fire's session. */
	proposals: number;
	/** issues.schedule_run_id */
	issues: number;
	/** The run a runner-less fire started (a release cut); a prompt fire's own run is not counted. */
	runs: number;
	/** notifications.schedule_run_id */
	notifications: number;
}

export interface FireStanding {
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
	attentionGroup: FireGroup;
	waitingOn: AutomationWaitingOn;
}

export interface ReportFireRef {
	id: string;
	scheduleId: string;
	scheduleName: string;
}

export interface ReportStanding extends AgentReportView {
	fire: ReportFireRef | null;
	attentionGroup: ReportGroup;
	waitingOn: AutomationWaitingOn;
}

/** A steward action a fire's session proposed or applied, read off that session's run report. */
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
	/** The newest fires, newest first. */
	fires: FireStanding[];
	firesTotal: number;
	firesHasMore: boolean;
	/** Every report at triage new, high severity then oldest, then the newest triaged ones. */
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

export interface ScheduleDetailResponse {
	schedule: ScheduleStanding;
	fires: Array<FireStanding & { output: string | null }>;
	firesTotal: number;
	firesHasMore: boolean;
	/** Every report this schedule's fires filed. */
	reports: ReportStanding[];
	/** The proposals of the fires served, newest first. */
	proposals: FireProposal[];
}
