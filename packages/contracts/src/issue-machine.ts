// The issue machine: workflow `issue-lifecycle`, approved revision 3. A status answers only "who is
// it waiting on"; a run's step is progress inside `in_progress`, kept in `issue_work_state`.

import { defineMachine, type MachineEdge } from "./state-machine.js";

export const ISSUE_STATUSES = [
	"draft",
	"open",
	"reopen",
	"in_progress",
	"approved",
	"needs_info",
	"on_hold",
	"awaiting_release",
	"closed",
	"dropped",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** The two parks: each stores the status it left (`issue_work_state.left_status`) and returns to it. */
export const PARK_STATUSES: readonly IssueStatus[] = ["needs_info", "on_hold"];

/** Where a park is entered from, and so where its return may land. */
export const PARKABLE_STATUSES: readonly IssueStatus[] = [
	"open",
	"reopen",
	"in_progress",
	"approved",
	"awaiting_release",
];

/** The issue is over, whichever exit it took. */
export const ISSUE_TERMINAL_STATUSES: readonly IssueStatus[] = ["closed", "dropped"];

/** What a master may start work from: the backlog, the plan checkpoint, a reopen. */
export const TAKEABLE_STATUSES: readonly IssueStatus[] = ["open", "approved", "reopen"];

/** Stopped until a person answers: what Needs you and the park view both count. */
export const AWAITING_INPUT_STATUSES: readonly IssueStatus[] = ["needs_info"];

/** A run is working it right now; its step is on `issue_work_state`. */
export const ASSERTS_WORK_IN_PROGRESS: readonly IssueStatus[] = ["in_progress"];

/** Nothing is left to do on it: a job that failed against it no longer matters, and a `blocks`
 *  edge onto it is settled. */
export const ISSUE_RESOLVED_STATUSES: readonly IssueStatus[] = ["awaiting_release", "closed"];

/** Not counted as open work in a project's totals. */
export const NON_OPEN_STATUSES: readonly IssueStatus[] = [
	"awaiting_release",
	"closed",
	"draft",
	"dropped",
];

/** A dispatch the move ends: the work left the pipeline's hands. */
export const ISSUE_DISPATCH_TERMINAL_STATUSES: readonly IssueStatus[] = [
	"awaiting_release",
	"closed",
	"dropped",
];

/** The guards the issue machine names; core implements each in `issues/transition-guards.ts`. */
export const ISSUE_GUARDS = [
	"holder",
	"plan_checkpoint",
	"verdicts",
	"left_status",
	"unheld",
] as const;
export type IssueGuard = (typeof ISSUE_GUARDS)[number];

const MOVE = "issues.transition";

type IssueEdge = MachineEdge<IssueStatus> & { readonly guards: readonly IssueGuard[] };

const sideExits = (from: IssueStatus): IssueEdge[] => [
	{ from, to: "needs_info", act: "question.asked", permission: MOVE, guards: [] },
	{ from, to: "on_hold", act: "paused", permission: MOVE, guards: [] },
	{ from, to: "dropped", act: "not.work", permission: MOVE, guards: [] },
];

/** A park returns to the status it left; `left_status` refuses any other of these. */
const parkReturns = (from: IssueStatus, act: string): IssueEdge[] =>
	PARKABLE_STATUSES.map((to) => ({ from, to, act, permission: MOVE, guards: ["left_status"] }));

const recovery = (to: IssueStatus, guards: readonly IssueGuard[]): IssueEdge => ({
	from: "in_progress",
	to,
	act: "handed.back",
	permission: MOVE,
	guards: ["unheld", ...guards],
	recovery: true,
});

export const ISSUE_MACHINE = defineMachine({
	entity: "issue",
	design: { flow: "issue-lifecycle", revision: 3 },
	states: ISSUE_STATUSES,
	initial: ["draft", "open"],
	terminal: ISSUE_TERMINAL_STATUSES,
	reasonRequired: ["reopen", "needs_info", "on_hold", "dropped"],
	edges: [
		{ from: "draft", to: "open", act: "admitted", permission: MOVE, guards: [] },
		{ from: "draft", to: "dropped", act: "not.work", permission: MOVE, guards: [] },

		{ from: "open", to: "in_progress", act: "run.claimed", permission: MOVE, guards: ["holder"] },
		...sideExits("open"),

		{ from: "reopen", to: "in_progress", act: "run.claimed", permission: MOVE, guards: ["holder"] },
		...sideExits("reopen"),

		{ from: "in_progress", to: "approved", act: "plan.recorded", permission: MOVE, guards: ["plan_checkpoint"] },
		{ from: "in_progress", to: "awaiting_release", act: "verdicts.passed", permission: MOVE, guards: ["verdicts"] },
		{ from: "in_progress", to: "closed", act: "shipped", permission: MOVE, guards: ["verdicts"] },
		...sideExits("in_progress"),

		{ from: "approved", to: "in_progress", act: "run.claimed", permission: MOVE, guards: ["holder"] },
		...sideExits("approved"),

		{ from: "awaiting_release", to: "closed", act: "release.recorded", permission: MOVE, guards: [] },
		{ from: "awaiting_release", to: "reopen", act: "release.failed", permission: MOVE, guards: [] },
		...sideExits("awaiting_release"),

		...parkReturns("needs_info", "answered"),
		{ from: "needs_info", to: "on_hold", act: "paused", permission: MOVE, guards: [] },
		{ from: "needs_info", to: "dropped", act: "not.work", permission: MOVE, guards: [] },

		...parkReturns("on_hold", "lifted"),
		{ from: "on_hold", to: "needs_info", act: "question.asked", permission: MOVE, guards: [] },
		{ from: "on_hold", to: "dropped", act: "not.work", permission: MOVE, guards: [] },

		{ from: "closed", to: "reopen", act: "returned", permission: MOVE, guards: [] },

		recovery("open", []),
		recovery("approved", ["plan_checkpoint"]),
		recovery("reopen", []),
	],
});
