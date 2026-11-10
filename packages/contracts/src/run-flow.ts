// How a project's runs move (`GET /api/projects/:id/runs/flow`, REQ-43 r3 BC-16): runs started and
// runs finished on each of the last days, in the reader's calendar, the Agents page band's one chart.
// It counts the runs the run list counts (no chat, no master's own run); finished is the day a run's
// own finish was recorded.

import { PROJECT_HOME_DAYS } from "./project-home.js";

/** The days the flow reads, today included: the home's window. */
export const RUN_FLOW_DAYS = PROJECT_HOME_DAYS;

export const RUN_FLOW_QUERY_SHAPE =
	"tz? — an IANA time zone, e.g. Asia/Ho_Chi_Minh (default UTC): the zone a day is counted in";

export interface RunFlowDay {
	/** `YYYY-MM-DD` in the read's zone. */
	day: string;
	/** Runs started that day. */
	started: number;
	/** Runs whose finish was recorded that day. */
	finished: number;
}

export interface RunFlow {
	projectId: string;
	tz: string;
	/** The last `RUN_FLOW_DAYS` days, oldest first, today last. */
	days: RunFlowDay[];
}
