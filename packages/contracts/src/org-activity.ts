// What each project of a workspace works now and next (ISS-951, mockup MK-8): `GET
// /api/orgs/:orgId/activity` answers one row per project the caller can read, and the `org:<id>` room
// tells an open page when any of them moved (`org.activity.changed`), so it reads again without
// polling. Core groups each row; the screen draws the groups it is given and derives none.

import type { IssueStatus } from "./issue-machine.js";
import type { WorkStep } from "./issue-vocabulary.js";
import type { MasterState } from "./master-standing.js";
import type { NeedsYouDecisionGroup } from "./needs-you-decisions.js";
import type { ProjectNowSource } from "./project-now.js";

/**
 * Where a project stands, in the order the page lists them: `working` while its master is in a pass or
 * has runs out, or any issue is in flight; `waiting` while its master is stopped on a person's dialog;
 * `idle` while its master is idle with admissible work queued; `waiting` while people owe it a
 * decision or a release, or work is queued and no master takes it; `quiet` otherwise.
 */
export const ORG_ACTIVITY_GROUPS = ["working", "idle", "waiting", "quiet"] as const;
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
	key: string;
	title: string;
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
	/** When it entered that state; null where it has none. */
	since: string | null;
	lastPassEndedAt: string | null;
	lastBeatAt: string | null;
}

export interface OrgActivityProject {
	projectId: string;
	slug: string;
	name: string;
	group: OrgActivityGroup;
	master: OrgActivityMaster;
	now: OrgActivityNow[];
	/** `total` admissible issues; `items` the first of them, in the master's order. */
	next: { total: number; items: OrgActivityNext[] };
	/** `total` decisions waiting on the caller; `items` the first of them. */
	people: { total: number; items: OrgActivityPerson[] };
	release: OrgActivityRelease | null;
	/** Issues landed and waiting for a release. */
	awaitingRelease: number;
}

export interface OrgActivity {
	generatedAt: string;
	orgId: string;
	/** Every project of the org the caller can read, in group order, then by name. */
	projects: OrgActivityProject[];
	totals: {
		projects: number;
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
