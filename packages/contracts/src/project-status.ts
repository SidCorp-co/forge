// One read of how a project stands (`GET /api/projects/:id/status`, JU-1, JU-3, JU-4, JU-10): what
// shipped, what is in flight, what waits on whom, how far requirements are proven, the next release
// and the roadmap. Core assembles it from the read models the dashboard, Releases and Requirements
// already draw, so a status report and the screens it summarises cannot disagree. Every section
// carries `asOf`, the moment its own read answered, and a forecast carries its own label.

import type { DeliveryForecast, ForecastLate, ScopeForecast } from "./forecast.js";
import type { IssueStatus } from "./issue-machine.js";
import type { NeedsYouAreaKey, NeedsYouEntity } from "./needs-you.js";
import type { ReleaseContentGroup, ReleaseVerified } from "./releases.js";
import type { RequirementState } from "./requirements.js";
import type { WaitingOn } from "./standing.js";

export const PROJECT_STATUS_DAYS_DEFAULT = 7;
export const PROJECT_STATUS_DAYS_MAX = 90;
/** The most rows any one list of the read carries; its count says how many there were. */
export const PROJECT_STATUS_ROWS = 25;

export const PROJECT_STATUS_QUERY_SHAPE = `days? — a whole number of days, 1..${PROJECT_STATUS_DAYS_MAX} (default ${PROJECT_STATUS_DAYS_DEFAULT}): the window "shipped" and "decided" are read over`;

/** The moment a section's read answered. */
interface Stamped {
	asOf: string;
}

export interface StatusShippedRelease {
	version: string;
	releasedAt: string;
	headline: string;
	issueCount: number;
	/** The requirements its issues serve, by key. */
	requirements: string[];
	/** Its issues, grouped by the requirement each serves. */
	contents: ReleaseContentGroup[];
	verified: ReleaseVerified;
}

/** What reached people inside the window: shipped releases, newest first. */
export interface StatusShipped extends Stamped {
	since: string;
	/** The newest shipped release, inside the window or not; null where nothing has ever shipped. */
	latest: StatusShippedRelease | null;
	releases: StatusShippedRelease[];
	/** Every shipped release in the window; `releases` carries at most PROJECT_STATUS_ROWS. */
	releaseCount: number;
	issueCount: number;
	/** Requirements whose last issue shipped inside the window. */
	requirementsShipped: { key: string; title: string; at: string }[];
}

export interface StatusInFlightIssue {
	key: string;
	title: string;
	status: IssueStatus;
	waitingOn: WaitingOn;
}

/** Open work by stage, and the issues a run is on right now. */
export interface StatusInFlight extends Stamped {
	byStatus: { status: IssueStatus; count: number }[];
	open: number;
	/** Issues a job or run is queued or running on. */
	running: StatusInFlightIssue[];
	runningCount: number;
	/** Fewer issues were read than are open, so `byStatus` counts the read rows only. */
	truncated: boolean;
}

export interface StatusWait {
	area: NeedsYouAreaKey;
	entity: NeedsYouEntity;
	key: string;
	title: string;
	waitingOn: WaitingOn;
	touchedAt: string | null;
}

/** Every row whose turn is a person's, with the person and the act its read model names. */
export interface StatusWaits extends Stamped {
	people: StatusWait[];
	peopleCount: number;
	/** The viewer's own needs-you count, the number the dashboard and the inbox show. */
	needsYou: number;
}

export interface StatusRequirement {
	key: string;
	title: string;
	state: RequirementState;
	/** BCs of the shown revision holding a passing traced verdict, of all its BCs. */
	criteria: { proven: number; total: number };
	issues: { shipped: number; live: number };
	waitingOn: WaitingOn;
	/** When the last of its issues is in people's hands; null where it holds no open work. */
	delivery: DeliveryForecast | null;
}

/** Requirements on the delivery line, and how many of their criteria are proven. */
export interface StatusRequirements extends Stamped {
	proven: number;
	total: number;
	byState: { state: RequirementState; count: number }[];
	items: StatusRequirement[];
}

/** The draft release: what it holds, when it is forecast to reach people and who cuts it. */
export interface StatusNextRelease extends Stamped {
	version: string | null;
	issueCount: number;
	requirements: string[];
	forecast: ScopeForecast | null;
	cut: { who: string; act: string } | null;
}

export interface StatusLateItem {
	kind: "requirement" | "feedback" | "release";
	key: string;
	title: string;
	late: ForecastLate;
}

export interface StatusLate extends Stamped {
	items: StatusLateItem[];
}

export const ROADMAP_HORIZONS = ["now", "next", "later"] as const;
export type RoadmapHorizon = (typeof ROADMAP_HORIZONS)[number];

/** How each horizon is filled and ordered, stated once so a reader can check the placement. */
export const ROADMAP_RULES: Record<RoadmapHorizon, string> = {
	now: "in delivery: its issues are being worked; soonest forecast landing first",
	next: "agreed and not yet in delivery, soonest forecast first, then the oldest key",
	later:
		"deferred, with the reason and phase it was deferred to, then drafts not agreed yet, oldest key first",
};

export interface RoadmapItem {
	key: string;
	title: string;
	state: RequirementState;
	delivery: DeliveryForecast | null;
	deferral: { reason: string; targetPhase: string | null; deferredAt: string } | null;
}

export interface StatusRoadmap extends Stamped {
	now: RoadmapItem[];
	next: RoadmapItem[];
	later: RoadmapItem[];
}

export interface ProjectStatus {
	projectId: string;
	slug: string;
	name: string;
	/** When the read began; each section's `asOf` says when its own figure answered. */
	asOf: string;
	days: number;
	viewer: { id: string; name: string | null };
	shipped: StatusShipped;
	inFlight: StatusInFlight;
	waits: StatusWaits;
	requirements: StatusRequirements;
	nextRelease: StatusNextRelease;
	late: StatusLate;
	roadmap: StatusRoadmap;
}
