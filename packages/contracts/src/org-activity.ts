// What each project of a workspace works now and next (ISS-951, mockups MK-8 and MK-9): `GET
// /api/orgs/:orgId/activity` answers one row per project the caller can read, and the `org:<id>` room
// tells an open page when any of them moved (`org.activity.changed`), so it reads again without
// polling. Core groups each row; the screen draws the groups it is given and derives none.
//
// No key is text a person reads (ISS-951 round 4, the owner's UI rule): every title and question
// here is read through `record-keys.ts:withoutRecordKeys`, and a `key` or `issueKey` field is for a
// link target, an aria label or a tooltip only.

import type { IssueStatus } from "./issue-machine.js";
import type { WorkStep } from "./issue-vocabulary.js";
import type { MasterPane, MasterState, MasterVerb } from "./master-standing.js";
import type { DecisionOpens, NeedsYouDecisionGroup } from "./needs-you-decisions.js";
import type { ProjectNowSource } from "./project-now.js";

/**
 * Where a project's master stands (ISS-979, the owner's mockup v3), by its one state
 * (`masters/state.ts:masterStateOf`) and never by an in-progress issue (MK-9): `working` while it is in
 * a pass, busy by hand or has runs out; `paused` while it takes no new work (its box is silent, its pane
 * is stopped on a dialog, or its box takes no new run); `idle` otherwise; `none` where no master stands.
 */
export const ORG_ACTIVITY_STANDINGS = ["working", "idle", "paused", "none"] as const;
export type OrgActivityStanding = (typeof ORG_ACTIVITY_STANDINGS)[number];

/** Why a master reads `paused`, for the tooltip on its state: never drawn as text on the row. */
export const ORG_ACTIVITY_PAUSE_REASONS = ["silent", "dialog", "no_new_work"] as const;
export type OrgActivityPauseReason = (typeof ORG_ACTIVITY_PAUSE_REASONS)[number];

/**
 * The groups the page lists, in its order: `you` first, holding every project with something waiting
 * on the reader whatever its master does, then each master standing. The filter chips count projects
 * in the same groups, so a chip and a group never disagree.
 */
export const ORG_ACTIVITY_GROUPS = ["you", ...ORG_ACTIVITY_STANDINGS] as const;
export type OrgActivityGroup = (typeof ORG_ACTIVITY_GROUPS)[number];

/** Moves on one project closer than this to the first move of a batch fall in that batch (the mockup's 15 min). */
export const ORG_ACTIVITY_BATCH_MINUTES = 15;

/** How many of a project's next issues a row carries by name. */
export const ORG_ACTIVITY_LIST_LIMIT = 5;

/** How many of the decisions a project waits on the reader for a row carries by name, each placed on its lane. */
export const ORG_ACTIVITY_WAIT_LIMIT = 20;

/** How many of a release's issues its marker lists by name; `total` counts every one. */
export const ORG_ACTIVITY_RELEASE_ISSUES = 8;

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
	/** The decision's own id, which the project's Approvals page opens it by to answer it. */
	decisionId: string;
	group: NeedsYouDecisionGroup;
	/** The issue, requirement or feedback key it is asked on, for a tooltip; null for a question asked on nothing. */
	key: string | null;
	/** A question's own words, or the item's title, on one line, with no record key in it. */
	title: string;
	/** When the wait began, as the decision records it (`NeedsYouDecision.touchedAt`); null where it records none. */
	since: string | null;
	/** The record that opens to read it, as Needs you names it; null where no record holds it. */
	opens: DecisionOpens | null;
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
	/** The issue's key, for a tooltip. */
	issueKey: string | null;
	/** The issue's title, as a person reads it; null where no issue of the project answers the key. */
	issueTitle: string | null;
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
	/** `you` where anything waits on the reader, else its master's standing. */
	group: OrgActivityGroup;
	/** Its master's standing, which the row's state reads whatever group it sits in. */
	standing: OrgActivityStanding;
	/** Why it reads `paused`; null on any other standing. */
	pause: OrgActivityPauseReason | null;
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
	/** What the project recorded over the last {@link ORG_ACTIVITY_LANE_MINUTES} minutes, drawn as its timeline lane. */
	lane: OrgActivityLane;
	/** When core last recorded anything on the project (a move, a run, a pass, a release); null where nothing is recorded. */
	lastActivityAt: string | null;
}

/** How far back a project's timeline lane reaches. */
export const ORG_ACTIVITY_LANE_MINUTES = 120;

/** A stretch of time on a lane; `to` null while it still runs. */
export interface OrgActivitySpan {
	from: string;
	to: string | null;
}

/** One issue of a batch: its first status in the batch and its last, by title, its key for a link and a tooltip. */
export interface OrgActivityBatchMove {
	issueKey: string;
	title: string | null;
	from: IssueStatus | null;
	to: IssueStatus;
}

/**
 * Status moves made close in time on one project (within {@link ORG_ACTIVITY_BATCH_MINUTES} of its
 * first), drawn as one numbered marker at `at`, its first move: one entry per issue moved.
 */
export interface OrgActivityBatch {
	at: string;
	moves: OrgActivityBatchMove[];
}

/** A release marker's state: `released` shipped or landed, `releasing` still running, `failed`, or `stopped` (aborted). */
export const ORG_ACTIVITY_RELEASE_STATES = ["released", "releasing", "failed", "stopped"] as const;
export type OrgActivityReleaseState = (typeof ORG_ACTIVITY_RELEASE_STATES)[number];

/** A release cut, shipped or ended on the lane: at its ship, else its start while it runs, else its end. */
export interface OrgActivityLaneRelease {
	at: string;
	version: string;
	state: OrgActivityReleaseState;
	/** Every issue it carries. */
	total: number;
	/** The first {@link ORG_ACTIVITY_RELEASE_ISSUES} of them, by title, the key for a link and a tooltip. */
	issues: { key: string; title: string }[];
}

/**
 * Decisions waiting on the reader that began close in time, drawn as one amber pin at `at`, where the
 * first of them began (the lane's start where it began before it, or where core holds no start).
 * `more` counts the decisions past what the read carries by name: core holds no start for them, so
 * they stand on the pin at the lane's start, and every lane's pins add up to the reader's total.
 */
export interface OrgActivityWait {
	at: string;
	items: OrgActivityPerson[];
	more: number;
}

/**
 * One project's lane, read by core (ISS-979, the owner's mockup v3): its runs as bars, its issues'
 * status moves grouped into batches, its releases and the decisions waiting on the reader, from `from`
 * to the read's `generatedAt`. A master pass is not drawn: a pass that took something shows as the run
 * it started, and one that took nothing says nothing.
 */
export interface OrgActivityLane {
	from: string;
	runs: OrgActivitySpan[];
	batches: OrgActivityBatch[];
	releases: OrgActivityLaneRelease[];
	waits: OrgActivityWait[];
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
	/** How many projects each group holds, and all of them: the filter chips' counts, in projects. */
	totals: { projects: number } & Record<OrgActivityGroup, number>;
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
	/** The issue it was on, by key, for a tooltip. */
	issueKey: string | null;
	/** That issue's title, as a person reads it; null where it names none or no issue answers the key. */
	issueTitle: string | null;
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
