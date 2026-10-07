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
export const FORECAST_LABEL = "forecast" as const;

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
}

/** Waiting on a person, a gate or an outage: no date, the wait named instead. */
export interface ForecastPaused extends ForecastStamp {
	kind: "paused";
	who: string;
	act: string;
	reason: string;
	/** The issue, refusal code or device the wait is on, where there is one. */
	ref: string | null;
}

export interface ForecastNoHistory extends ForecastStamp {
	kind: "not_enough_history";
	n: number;
	floor: number;
}

export interface ForecastLanded extends ForecastStamp {
	kind: "landed";
	/** Null where the issue sits past the landing with no merge time recorded. */
	landedAt: string | null;
}

/** Dropped, or otherwise ended without landing: nothing is forecast. */
export interface ForecastEnded extends ForecastStamp {
	kind: "ended";
	status: string;
}

export type Forecast =
	| ForecastRange
	| ForecastPaused
	| ForecastNoHistory
	| ForecastLanded
	| ForecastEnded;
export type ForecastKind = Forecast["kind"];

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

export const FORECAST_SCOPES = ["requirement", "release"] as const;
export type ForecastScope = (typeof FORECAST_SCOPES)[number];

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
}
