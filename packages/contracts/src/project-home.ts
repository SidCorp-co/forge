// The project home's one read (`GET /api/projects/:id/home`, REQ-43 BC-14..BC-18): every figure the
// home draws — the loop's four stages, its two charts and Needs you — in one answer, counted from the
// very lists the Requirements, Issues, Releases, Feedback and Debt pages read, so a figure on the home
// and the list it summarises cannot disagree (L-57). Days and weeks are the reader's: `tz` names the
// zone a day is counted in.

import type { DebtKind, ImpactRating, ImpactType } from "./cleanup.js";
import type { IssueStatus } from "./issue-machine.js";
import type { WorkStep } from "./issue-vocabulary.js";
import type { NeedsYouDecision } from "./needs-you-decisions.js";
import type { ReleaseState } from "./releases.js";
import type { RequirementState } from "./requirements.js";
import type { WrittenLang } from "./written-lang.js";

/** The days the Release stage and the shipped chart read, today included. */
export const PROJECT_HOME_DAYS = 14;
/** The weeks the feedback chart reads, this week included; a week starts on Monday. */
export const PROJECT_HOME_WEEKS = 6;
/** The most open issues the Delivery board names; `delivery.open` counts every one. */
export const PROJECT_HOME_ISSUES = 60;
/** The newest shipped releases the Release drawer lists. */
export const PROJECT_HOME_RECENT = 3;
/** The most places one Audit cell names. */
export const PROJECT_HOME_PLACES = 3;
/** The most releases the timeline carries. */
export const PROJECT_HOME_TIMELINE_MAX = 500;

export const PROJECT_HOME_QUERY_SHAPE =
	"tz? — an IANA time zone, e.g. Asia/Ho_Chi_Minh (default UTC): the zone a day and a week are counted in";

/** Whether `tz` names a time zone this runtime can count days in. */
export function isTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

export interface HomeCount<K extends string> {
	key: K;
	count: number;
}

/** One business area: its requirements in play, how many are being built, and its proven criteria. */
export interface HomeArea {
	/** The area's name; null for requirements no area holds. */
	name: string | null;
	requirements: number;
	building: number;
	proven: number;
	total: number;
}

export interface HomeProduct {
	/** Requirements in play (every one not dropped or refused), as the Requirements page's strips count them. */
	requirements: number;
	/** Those requirements by state, each state in play that holds one. */
	byState: HomeCount<RequirementState>[];
	/** Criteria proven of all, over the requirements on the delivery line, as the status report reads them. */
	criteria: { proven: number; total: number };
	/** The same, by area, largest first. */
	areas: HomeArea[];
	/** Feedback reports neither done nor declined (a duplicate counts under its original). */
	feedbackOpen: number;
}

/** One open issue as the Delivery board draws it. */
export interface HomeIssue {
	key: string;
	title: string;
	titleLang: WrittenLang | null;
	status: IssueStatus;
	priority: string;
	step: WorkStep | null;
	touchedAt: string;
	/** A job or run is queued or running on it. */
	running: boolean;
}

export interface HomeDelivery {
	/** Open issues, as the Issues page's open scope counts them. */
	open: number;
	byStatus: HomeCount<IssueStatus>[];
	/** Issues a job or run is on now. */
	running: number;
	/** The open issues the board names, newest write first, at most `PROJECT_HOME_ISSUES`. */
	issues: HomeIssue[];
	/** More are open than `issues` names. */
	truncated: boolean;
}

export interface HomeRelease {
	version: string;
	name: string | null;
	issueCount: number;
	releasedAt: string;
}

/** One day of the shipped chart: releases shipped that day and the issues they carried. */
export interface HomeShipDay {
	/** `YYYY-MM-DD` in the read's zone. */
	day: string;
	releases: number;
	issues: number;
}

export interface HomeReleaseStage {
	/** The last `PROJECT_HOME_DAYS` days, oldest first, today last. */
	days: HomeShipDay[];
	/** Releases shipped over those days, and the issues they carried. */
	shipped: number;
	issues: number;
	/** Every release cut over those days, by state (drafts are not cut). */
	byState: HomeCount<ReleaseState>[];
	/** Each release shipped over those days, oldest first. */
	timeline: HomeRelease[];
	/** The newest `PROJECT_HOME_RECENT` releases that shipped, at any time, newest first. */
	recent: HomeRelease[];
}

/** Open findings of one impact type and one kind, and the places most of them sit. */
export interface HomeAuditCell {
	type: ImpactType;
	kind: DebtKind;
	count: number;
	places: { where: string; count: number }[];
}

export interface HomeAudit {
	/** Open findings, as the debt ledger lists them. */
	open: number;
	cleared: number;
	byKind: HomeCount<DebtKind>[];
	byRating: HomeCount<ImpactRating>[];
	/** Every impact type × kind that holds a finding. */
	cells: HomeAuditCell[];
}

/** One week of feedback, by how it ended so far. */
export interface HomeFeedbackWeek {
	/** The week's Monday, `YYYY-MM-DD` in the read's zone. */
	week: string;
	fixed: number;
	declined: number;
	open: number;
}

export interface HomeNeedsYou {
	/** The first decisions, in the Needs you read's order, at most `NEEDS_YOU_PERSON_CAP`. */
	decisions: NeedsYouDecision[];
	/** Every decision waiting on the reader: the one Needs you number. */
	total: number;
}

export interface ProjectHome {
	projectId: string;
	asOf: string;
	tz: string;
	product: HomeProduct;
	delivery: HomeDelivery;
	release: HomeReleaseStage;
	audit: HomeAudit;
	/** The last `PROJECT_HOME_WEEKS` weeks, oldest first. */
	feedback: { weeks: HomeFeedbackWeek[] };
	needsYou: HomeNeedsYou;
}
