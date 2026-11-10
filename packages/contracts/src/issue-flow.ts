// How a project's issues move (`GET /api/projects/:id/issues/flow`, REQ-43 r3 BC-16): issues opened
// and issues closed on each of the last days, in the reader's calendar, the Issues page band's one
// chart. Closed is a move into a terminal status, the statuses the Issues page's Closed scope lists;
// an issue closed twice in a day counts once that day.

import { PROJECT_HOME_DAYS } from "./project-home.js";

/** The days the flow reads, today included: the home's window. */
export const ISSUE_FLOW_DAYS = PROJECT_HOME_DAYS;

export const ISSUE_FLOW_QUERY_SHAPE =
	"tz? — an IANA time zone, e.g. Asia/Ho_Chi_Minh (default UTC): the zone a day is counted in";

export interface IssueFlowDay {
	/** `YYYY-MM-DD` in the read's zone. */
	day: string;
	/** Issues filed that day and not archived. */
	opened: number;
	/** Issues moved into a terminal status that day. */
	closed: number;
}

export interface IssueFlow {
	projectId: string;
	tz: string;
	/** The last `ISSUE_FLOW_DAYS` days, oldest first, today last. */
	days: IssueFlowDay[];
}
