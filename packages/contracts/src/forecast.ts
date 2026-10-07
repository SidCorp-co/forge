/**
 * When work is forecast to land: a range read off the project's own history, never a promise.
 *
 * Every answer carries `label: "forecast"` and its `asOf`, so no surface can show it as a date
 * Forge committed to (VISION: state-never-lies). A forecast is never one date: it is the p50 and
 * the p85 of a Monte Carlo over the project's in_progress→landed durations, run through the queue
 * in the order its masters are handed work, its `blocks` edges and its observed concurrency.
 */

/** Fewer landed issues than this in the window and no number is given. */
export const FORECAST_HISTORY_FLOOR = 10;
/** The days of landings the history is read from. */
export const FORECAST_WINDOW_DAYS = 60;
export const FORECAST_TRIALS = 1000;
/** The recent days the most runs live at once is read over: the simulation never works more. */
export const FORECAST_PEAK_DAYS = 14;
export const FORECAST_LABEL = "forecast" as const;
/** A person's turn that has gone unanswered this long reads late, whatever the forecast says. */
export const FORECAST_WAIT_LATE_MINUTES = 24 * 60;

export const FORECAST_LATE_REASONS = ["p85_passed", "waiting_over_day"] as const;
export type ForecastLateReason = (typeof FORECAST_LATE_REASONS)[number];

/**
 * An open item taking longer than it should: its work has run past the p85 of similar landed work
 * (`p85_passed`), or a person has owed the next act for over a day (`waiting_over_day`). Core
 * decides it once, at read time, so no screen computes its own lateness.
 */
export interface ForecastLate {
	reason: ForecastLateReason;
	/** The moment it became late: the p85 point, or the day mark of the wait. */
	since: string;
	/** Whole minutes past that moment as of the read. */
	byMinutes: number;
}

/** What the numbers were read from, so a reader can judge the range for themselves. */
export interface ForecastBasis {
	/** Landed issues the durations were sampled from. */
	n: number;
	floor: number;
	windowDays: number;
	/** The complexity whose own durations were sampled; null where the whole history was. */
	complexity: string | null;
	/** The sampled history's own p50 and p85 in minutes, from work start to landing. */
	cycleP50Minutes: number;
	cycleP85Minutes: number;
	/** Landings per day over the window. */
	throughputPerDay: number;
	/** How many issues the simulation works at once. */
	concurrency: number;
	/** How `concurrency` was read. */
	concurrencyBasis: string;
}

interface ForecastStamp {
	label: typeof FORECAST_LABEL;
	asOf: string;
}

export interface ForecastRange extends ForecastStamp {
	kind: "forecast";
	p50At: string;
	p85At: string;
	p50Minutes: number;
	p85Minutes: number;
	/** Issues the dispatcher takes before this one, in flight or queued ahead of it. */
	ahead: number;
	aheadKeys: string[];
	/** Unsettled `blocks` blockers this one waits on, the critical path's first step. */
	waitsOn: string[];
	basis: ForecastBasis;
	/** Non-null once work already under way has run past the p85 of similar landed work. */
	late: ForecastLate | null;
}

/** Waiting on a person, a gate or an outage: no date, the wait named instead. */
export interface ForecastPaused extends ForecastStamp {
	kind: "paused";
	who: string;
	act: string;
	reason: string;
	/** The issue, refusal code or device the wait is on, where there is one. */
	ref: string | null;
	/** When the wait began, where the read knows it; null where it does not, which is never late. */
	since: string | null;
	/** Non-null once a person has owed the act for more than a day. */
	late: ForecastLate | null;
}

interface ForecastNoHistory extends ForecastStamp {
	kind: "not_enough_history";
	n: number;
	floor: number;
}

interface ForecastLanded extends ForecastStamp {
	kind: "landed";
	/** Null where the issue sits past the landing with no merge time recorded. */
	landedAt: string | null;
}

/** Dropped, or otherwise ended without landing: nothing is forecast. */
interface ForecastEnded extends ForecastStamp {
	kind: "ended";
	status: string;
}

export type Forecast =
	| ForecastRange
	| ForecastPaused
	| ForecastNoHistory
	| ForecastLanded
	| ForecastEnded;

export interface IssueForecast {
	issueId: string;
	key: string;
	forecast: Forecast;
}

/** Every open issue's forecast from one simulation, for the board and its peek. */
export interface ProjectForecast extends ForecastStamp {
	projectId: string;
	/** A wait that holds the whole project, such as no runner able to take work. */
	pause: ForecastPaused | null;
	issues: IssueForecast[];
}

const FORECAST_SCOPES = ["requirement", "release"] as const;
type ForecastScope = (typeof FORECAST_SCOPES)[number];

/** A requirement's issues, or a draft release's: forecast when all of them have landed. */
export interface ScopeForecast extends ForecastStamp {
	scope: ForecastScope;
	key: string;
	total: number;
	landed: number;
	/** Null where the scope holds no issue. */
	forecast: Forecast | null;
	/** What follows once every issue has landed, such as a release a person cuts. */
	next: ForecastPaused | null;
	/** The requirement's title; null on a release. */
	title: string | null;
	/** When the last of them is in people's hands; null where the scope holds no issue. */
	delivery: DeliveryForecast | null;
}

/**
 * How a landed change reaches people, read off the project document: a release nobody acts on
 * (`automatic`: production deploys on land and no approval is required), one a holder of
 * releases.approve approves (`approval`), one an admin cuts (`manual`), or none at all (`none`: no
 * production environment, so a person releases it by hand).
 */
const RELEASE_MODES = [
	"automatic",
	"approval",
	"manual",
	"none",
] as const;
export type ReleaseMode = (typeof RELEASE_MODES)[number];

/** The project's own landed→released durations the release lag was sampled from. */
interface ReleaseLagBasis {
	n: number;
	floor: number;
	windowDays: number;
	lagP50Minutes: number;
	lagP85Minutes: number;
}

/** A person who owes the release act, named where core could resolve who holds the permission. */
export interface ReleaseHolder {
	id: string;
	name: string;
	kind: "human" | "agent";
}

/** What follows a landing before the change is in people's hands. */
export type ReleaseLeg =
	| { kind: "automatic"; basis: ReleaseLagBasis }
	| { kind: "not_enough_history"; n: number; floor: number }
	| {
			kind: "person";
			mode: Exclude<ReleaseMode, "automatic">;
			/** The holder named when one or two hold it, the count when more, the role when none could be resolved. */
			who: string;
			act: string;
			reason: string;
			/** The version the act cuts, the page its line links to; null where no cut is owed (`none`). */
			version: string | null;
			/** Everyone holding the permission the act takes; empty where the mode names a role only. */
			holders: ReleaseHolder[];
	  };

/** A p50–p85 span from now, with no basis of its own: the parts it adds carry theirs. */
export interface ForecastSpan {
	p50At: string;
	p85At: string;
	p50Minutes: number;
	p85Minutes: number;
}

/**
 * Done as a person means it: in their hands, not merged. The landing, then what the release adds:
 * a span only where no person acts and both halves have history, else the person and the act
 * named with no date (VISION: state-never-lies).
 */
export interface DeliveryForecast extends ForecastStamp {
	landing: Forecast;
	/** Null once shipped, or where the landing holds no date to follow. */
	release: ReleaseLeg | null;
	/** Landing plus release lag, trial by trial; null wherever a person, a wait or a short history holds it. */
	inHands: ForecastSpan | null;
	/** The version that shipped it and when; null until every issue has shipped. */
	shipped: { version: string | null; at: string | null } | null;
}

/** One feedback item: who triages it while untriaged, else its linked work's delivery. */
export interface FeedbackForecast {
	key: string;
	triage: ForecastPaused | null;
	/** Null where the item carries no work that ships: answered, declined, revision-routed. */
	delivery: DeliveryForecast | null;
}

export interface FeedbackForecasts extends ForecastStamp {
	projectId: string;
	items: FeedbackForecast[];
}

/** Every live requirement's scope forecast, from one simulation, for the list rows. */
export interface RequirementForecasts extends ForecastStamp {
	projectId: string;
	requirements: ScopeForecast[];
}

/** What comes next on Releases: each requirement with open work, soonest first, and the draft. */
export interface ComingNextForecast extends ForecastStamp {
	projectId: string;
	requirements: ScopeForecast[];
	draft: ScopeForecast;
}
