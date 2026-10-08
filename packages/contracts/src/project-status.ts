// One read of how a project stands (`GET /api/projects/:id/status`, JU-1, JU-3, JU-4, JU-10): what
// shipped, what is in flight, what waits on whom, how far requirements are proven, the next release
// and the roadmap. Core assembles it from the read models the dashboard, Releases and Requirements
// already draw, so a status report and the screens it summarises cannot disagree. Every section
// carries `asOf`, the moment its own read answered, and a forecast carries its own label.

import type { DeliveryForecast, ForecastLate, ForecastMove, IssueProgress, ScopeForecast } from "./forecast.js";
import type { WrittenLang } from "./written-lang.js";
import type { IssueStatus } from "./issue-machine.js";
import type { NeedsYouAreaKey, NeedsYouEntity } from "./needs-you.js";
import type {
	ReleaseContentGroup,
	ReleaseState,
	ReleaseVerified,
} from "./releases.js";
import type { RequirementState } from "./requirements.js";
import type { Said } from "./said.js";
import type { WaitingKind, WaitingOn } from "./standing.js";

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
	/** Requirements delivered in full inside the window: the last issue shipped AND every live criterion proven (`provenInFull`). */
	requirementsShipped: { key: string; title: string; at: string }[];
	/**
	 * Requirements whose last issue shipped inside the window while a live criterion is still unproven:
	 * shipped, not delivered in full. Absent on a report stored before the proof rule.
	 */
	requirementsAwaitingProof?: { key: string; title: string; at: string; proven: number; total: number }[];
}

/** Delivered in full: at least one live criterion, and every one proven. The status read and a release's `completes` read the same rule. */
export const provenInFull = (c: { proven: number; total: number }): boolean =>
	c.total > 0 && c.proven === c.total;

export interface StatusInFlightIssue {
	key: string;
	title: string;
	/** The language the title was written in; null when not kept. */
	titleLang: WrittenLang | null;
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
	/** The language `title` was written in; null when Forge composed it or the language was not kept. */
	titleLang: WrittenLang | null;
	waitingOn: WaitingOn;
	touchedAt: string | null;
	/** `title` as said (`said.ts`): a writer's words verbatim, Forge's own by key. */
	says: { title: Said };
}

/** One person (or role a person holds) and how many member asks wait on them. */
export interface StatusWaitPerson {
	kind: WaitingKind;
	who: string;
	says: { who: Said };
	count: number;
}

/**
 * Every member ask (`NEEDS_YOU_AREA_SPACE` = asks) whose turn is a person's, grouped by that person:
 * `byPerson` the one owing most first, and `people` the rows in that grouping, each person's oldest
 * first. Ops upkeep (agent reports, schedules, contracts) is Development's and never listed here.
 */
export interface StatusWaits extends Stamped {
	people: StatusWait[];
	/** The persons `people` is grouped by, in its order; absent on a report stored before the grouping. */
	byPerson?: StatusWaitPerson[];
	peopleCount: number;
	/** The viewer's own asks (`NeedsYouResponse.asks`), the number the home and /attention show. */
	needsYou: number;
}

export interface StatusRequirement {
	key: string;
	title: string;
	state: RequirementState;
	/** BCs of the shown revision holding a passing traced verdict, of all its BCs. */
	criteria: { proven: number; total: number };
	/** Its issues in the one progress vocabulary: shipped, landed awaiting release, to do (`IssueProgress`). */
	progress: IssueProgress;
	waitingOn: WaitingOn;
	/** When the last of its issues is in people's hands; null where it holds no open work. */
	delivery: DeliveryForecast | null;
	/** How its forecast last moved and why (`ScopeForecast.moved`); absent on a report stored before moves were kept. */
	moved?: ForecastMove | null;
}

/** Requirements on the delivery line, and how many of their criteria are proven. */
export interface StatusRequirements extends Stamped {
	proven: number;
	total: number;
	byState: { state: RequirementState; count: number }[];
	items: StatusRequirement[];
}

/**
 * The release nearest people's hands: one already cut and on its way (`in_progress`,
 * `awaiting_approval`, `returned`) before the draft, since a cut release reaches people first.
 */
export interface StatusNextRelease extends Stamped {
	version: string | null;
	state: ReleaseState | null;
	/** Its issues in the one progress vocabulary; all zero where no release is on its way. */
	progress: IssueProgress;
	requirements: string[];
	/** The draft's forecast; null for a release already cut, which the forecast does not model. */
	forecast: ScopeForecast | null;
	/** Whose act moves it next: the cut release's own turn, or whoever cuts the draft. */
	turn: { who: string; act: string; says: { who: Said; act: Said } } | null;
	/** The draft collecting behind a release already cut. */
	behind: { version: string; issueCount: number } | null;
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

/**
 * Where a requirement in this state stands on the roadmap (JU-10): in delivery is Now, agreed is
 * Next, deferred and draft are Later; delivered, accepted and dropped are on it no more. The one
 * rule the status report's roadmap and the Requirements list's roadmap grouping both read.
 */
export const ROADMAP_HORIZON_OF: Record<RequirementState, RoadmapHorizon | null> = {
	in_delivery: "now",
	agreed: "next",
	deferred: "later",
	draft: "later",
	delivered: null,
	accepted: null,
	dropped: null,
};

export interface RoadmapItem {
	key: string;
	title: string;
	state: RequirementState;
	delivery: DeliveryForecast | null;
	/** How its forecast last moved and why (`ScopeForecast.moved`); absent on a report stored before moves were kept. */
	moved?: ForecastMove | null;
	deferral: {
		reason: string;
		targetPhase: string | null;
		deferredAt: string;
	} | null;
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
