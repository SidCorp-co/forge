// What each project of a workspace works now and next (ISS-951, mockups MK-8 and MK-9): `GET
// /api/orgs/:orgId/activity` answers one row per project the caller can read, and the `org:<id>` room
// tells an open page when any of them moved (`org.activity.changed`), so it reads again without
// polling. Core groups each row; the screen draws the groups it is given and derives none.

import type { IssueStatus } from "./issue-machine.js";
import type { WorkStep } from "./issue-vocabulary.js";
import type { MasterPane, MasterState, MasterVerb } from "./master-standing.js";
import type { NeedsYouDecisionGroup } from "./needs-you-decisions.js";
import type { ProjectNowSource } from "./project-now.js";

/**
 * Where a project stands, in the order the page lists them, by its master's state alone and never by
 * an in-progress issue (MK-9): `running` while its master is in a pass, busy by hand or has runs
 * out; `idle` while its master is idle with a backlog; `waiting` while its master is stopped on a
 * person's dialog, people owe it a decision or a release, or a backlog stands and no master takes it;
 * `quiet` otherwise.
 */
export const ORG_ACTIVITY_GROUPS = ["running", "idle", "waiting", "quiet"] as const;
export type OrgActivityGroup = (typeof ORG_ACTIVITY_GROUPS)[number];

/** How many of a project's next issues, and of the decisions it waits on, a row carries by name. */
export const ORG_ACTIVITY_LIST_LIMIT = 5;

/** An issue the project works now: in progress, or carried by a release at its release step. */
export interface OrgActivityNow {
	issueId: string;
	key: string;
	title: string;
	status: IssueStatus;
	/** The step the work is at, as `issue_work_state` records it; null where none was recorded. */
	step: WorkStep | null;
	/** When it entered that step. */
	stepSince: string | null;
}

/** An issue the project's master would take next, in its own admissible order. */
export interface OrgActivityNext {
	issueId: string;
	key: string;
	title: string;
	priority: string | null;
}

/** A decision the project waits on the caller for, as Needs you lists it. */
export interface OrgActivityPerson {
	group: NeedsYouDecisionGroup;
	/** The issue, requirement or feedback key it is asked on; null for a question asked on nothing. */
	key: string | null;
	/** A question's own words, or the item's title, on one line. */
	title: string;
}

/**
 * Why the master's last pass took nothing while a backlog stood, read from what core held when it
 * settled: `one_at_a_time` its runs were out or its slots full, `pool_closed` its box takes no new
 * run there, `busy_by_hand` the pass was a turn somebody started at the pane.
 */
export const ORG_ACTIVITY_SKIP_REASONS = ["one_at_a_time", "pool_closed", "busy_by_hand"] as const;
export type OrgActivitySkipReason = (typeof ORG_ACTIVITY_SKIP_REASONS)[number];

/** What the master is doing: the open pass's verb and issue, else the issue of its newest live run. */
export interface OrgActivityDoing {
	kind: "pass" | "run";
	/** The pass's verb; null on a run. */
	verb: MasterVerb | null;
	issueKey: string | null;
}

/** The scope the project's next release carries: the soonest requirement still landing, or the draft release. */
export interface OrgActivityRelease {
	key: string;
	/** The requirement's title; null for the draft release. */
	title: string | null;
	shipped: number;
	awaitingRelease: number;
	total: number;
}

export interface OrgActivityMaster {
	state: MasterState;
	/** When it entered that state, by the state's own record; null where it has none. */
	since: string | null;
	lastPassEndedAt: string | null;
	/** When its box last spoke for it: the live update a person reads to tell it runs. */
	lastBeatAt: string | null;
	silentAfterSeconds: number;
	/** What the pane's hooks last said, live or as of its last pass. */
	pane: MasterPane | null;
	doing: OrgActivityDoing | null;
	/** The text of the dialog its pane is stopped on, while it waits on a person. */
	dialog: string | null;
}

export interface OrgActivityProject {
	projectId: string;
	slug: string;
	name: string;
	group: OrgActivityGroup;
	master: OrgActivityMaster;
	now: OrgActivityNow[];
	/**
	 * The backlog: `total` admissible issues, `items` the first of them in the master's order, and
	 * `skip` why its last pass took none of them where it took nothing.
	 */
	next: { total: number; items: OrgActivityNext[]; skip: OrgActivitySkipReason | null };
	/** `total` decisions waiting on the caller; `items` the first of them. */
	people: { total: number; items: OrgActivityPerson[] };
	/** True while the decisions it owes the reader are still being read, off the page's path. */
	peoplePending: boolean;
	release: OrgActivityRelease | null;
	/** True while its next release is still being read, off the page's path. */
	releasePending: boolean;
	/** Issues landed and waiting for a release. */
	awaitingRelease: number;
	/**
	 * What the project recorded over the last {@link ORG_ACTIVITY_LANE_MINUTES} minutes, drawn as its
	 * timeline lane (MK-10 C); null where no master stands, which the lane says.
	 */
	lane: OrgActivityLane | null;
}

/** How far back a project's timeline lane reaches. */
export const ORG_ACTIVITY_LANE_MINUTES = 120;

/** A stretch of time on a lane; `to` null while it still runs. */
export interface OrgActivitySpan {
	from: string;
	to: string | null;
}

/**
 * One project's lane (MK-10 C), read from the same events its Recent list reads: its master's passes
 * as ticks, its runs as bars, its issues' status moves as dots and the dialogs its master's pane
 * stopped on as amber bars, each from `from` to the read's `generatedAt`.
 */
export interface OrgActivityLane {
	from: string;
	/** When each pass opened. */
	passes: string[];
	runs: OrgActivitySpan[];
	/** When each status move was made. */
	moves: string[];
	dialogs: OrgActivitySpan[];
}

export interface OrgActivity {
	generatedAt: string;
	orgId: string;
	/** Every project of the org the caller can read, in group order, then by name. */
	projects: OrgActivityProject[];
	/**
	 * True while a project's release or decisions are being read again behind this answer: the page
	 * reads once more shortly, and stops when this is false. Never set in a steady state.
	 */
	refreshing: boolean;
	totals: {
		projects: number;
		/** Projects in the `running` group. */
		running: number;
		inFlight: number;
		queued: number;
		people: number;
		awaitingRelease: number;
		noMaster: number;
	};
}

/**
 * What moved on one of the org's projects: what runs there now (`ProjectNowSource`), an issue's status,
 * a pipeline run's status, or a question asked or settled. The page reads its activity again.
 */
export const ORG_ACTIVITY_SOURCES = ["status", "run", "question"] as const;
export type OrgActivitySource =
	| ProjectNowSource
	| (typeof ORG_ACTIVITY_SOURCES)[number];

export interface OrgActivityFrame {
	orgId: string;
	projectId: string;
	source: OrgActivitySource;
}

export const orgRoom = (orgId: string): string => `org:${orgId}`;

/** How many events a project's Recent list carries. */
export const ORG_ACTIVITY_RECENT_LIMIT = 8;

export const ORG_ACTIVITY_EVENT_KINDS = [
	"pass_opened",
	"pass_settled",
	"status",
	"merged",
	"change_request",
	"run_started",
	"run_ended",
	"dialog_started",
	"dialog_ended",
] as const;
export type OrgActivityEventKind = (typeof ORG_ACTIVITY_EVENT_KINDS)[number];

/** One thing core recorded on the project, as the peek's Recent list names it. */
export interface OrgActivityEvent {
	at: string;
	kind: OrgActivityEventKind;
	issueKey: string | null;
	/** A pass's verb. */
	verb?: MasterVerb;
	/** A settled pass: how many issues it dispatched. */
	dispatched?: number;
	/** A status move: the status it moved to. */
	to?: IssueStatus;
	/** A change request: its number as its host writes it (`!135`, `#12`). */
	ref?: string;
}

/** `GET /api/orgs/:orgId/activity/:projectId/recent`: read by the peek only, never by the list. */
export interface OrgActivityRecent {
	projectId: string;
	items: OrgActivityEvent[];
}
