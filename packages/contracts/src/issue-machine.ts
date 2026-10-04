// The issue machine: workflow `issue-lifecycle`, approved revision 8. A status answers only "who is
// it waiting on"; a run's step is progress inside `in_progress`, kept in `issue_work_state`. A
// landing moves no status: it records the merge, and an issue closes only through a release.

import type { Refusal, RefusalStatuses } from "./refusal.js";
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

/** The seventeen-status model's names the ten do not hold. Kernel input naming one is refused
 *  `ISSUE_STATUS_LEGACY`; none is mapped onto a status. */
const LEGACY_ISSUE_STATUSES = [
	"confirmed",
	"clarified",
	"waiting",
	"developed",
	"testing",
	"tested",
	"releasing",
] as const;
type LegacyIssueStatus = (typeof LEGACY_ISSUE_STATUSES)[number];
/** What a status move is refused with: the guards' codes, then the kernel's own. */
export const ISSUE_TRANSITION_REFUSAL_CODES = [
	"ILLEGAL_TRANSITION",
	"NO_HOLDER",
	"ISSUE_BLOCKED",
	"WORKFLOW_DESIGN_NOT_APPROVED",
	"CONTRACT_WAIT_UNSETTLED",
	"PLAN_REQUIRED",
	"PERMISSION_FORBIDDEN",
	"NO_WORK_EVIDENCE",
	"VERDICT_IDENTITY_REQUIRED",
	"VERDICT_PREDATES_REOPEN",
	"VERDICT_IDENTITY_NOT_ADMISSIBLE",
	"VERDICT_UNCORROBORATED",
	"VERDICT_DRAFT_SUPERSEDED",
	"REQUIREMENT_CHANGED_SINCE_PLAN",
	"MERGE_NOT_RECORDED",
	"CLOSE_REQUIRES_SHIPPED",
	"CLOSE_ONLY_BY_RELEASE",
	"TRANSITION_REASON_REQUIRED",
	"WAITING_KIND_REQUIRED",
	"VOID_REASON_REQUIRED",
	"NO_OP",
	"STALE_TRANSITION",
	"WAITING_KIND_NOT_APPLICABLE",
	"ISSUE_ARCHIVED",
	"OPEN_QUESTIONS",
] as const;
export type IssueTransitionRefusalCode = (typeof ISSUE_TRANSITION_REFUSAL_CODES)[number];
export const ISSUE_TRANSITION_REFUSAL_STATUSES = {
	NO_HOLDER: 409,
	STALE_TRANSITION: 409,
} as const satisfies RefusalStatuses<IssueTransitionRefusalCode>;

type IssueStatusLegacyRefusal = Refusal & {
	code: "ISSUE_STATUS_LEGACY";
	received: LegacyIssueStatus;
	validStatuses: readonly IssueStatus[];
};

export function isLegacyIssueStatus(value: string): value is LegacyIssueStatus {
	return (LEGACY_ISSUE_STATUSES as readonly string[]).includes(value);
}

export function issueStatusLegacyRefusal(
	received: LegacyIssueStatus,
	path: string,
): IssueStatusLegacyRefusal {
	return {
		code: "ISSUE_STATUS_LEGACY",
		path,
		detail: `\`${received}\` is a legacy status and is not accepted; name one of ${ISSUE_STATUSES.join(", ")}. A run's progress inside a status is \`workState.step\`.`,
		received,
		validStatuses: ISSUE_STATUSES,
	};
}

/** The statuses an issue is born at: `open` for an actor holding `issues.admit`, else `draft`. */
export const ISSUE_INITIAL_STATUSES = ["draft", "open"] as const satisfies readonly IssueStatus[];

/** Entering one of these carries the actor's reason. */
export const REASON_REQUIRED_STATUSES = ["reopen", "needs_info", "on_hold", "dropped"] as const;

/** The two parks: each stores the status it left (`issue_work_state.left_status`) and returns to it. */
export const PARK_STATUSES: readonly IssueStatus[] = ["needs_info", "on_hold"];

/** Where a park is entered from, and so where its return may land. */
const PARKABLE_STATUSES: readonly IssueStatus[] = [
	"open",
	"reopen",
	"in_progress",
	"approved",
	"awaiting_release",
];

/** The issue is over, whichever exit it took. */
export const ISSUE_TERMINAL_STATUSES: readonly IssueStatus[] = ["closed", "dropped"];

/** The status an issue stands at while its release is waiting to be pressed. */
export const BASE_MERGE_STATE: IssueStatus = "awaiting_release";

/** The status at which an autonomous project's driver is handed the issue. */
export const AUTONOMOUS_ENTRY_STATUS: IssueStatus = "open";

/** The one park the driver may enter, and the only one a human answer restarts. */
export const AUTONOMOUS_QUESTION_STATUS: IssueStatus = "needs_info";

/** Every status an autonomous project's issue stands at while the driver works it. */
export const AUTONOMOUS_DRIVER_STATUSES: readonly IssueStatus[] = [
	"open",
	"in_progress",
	"needs_info",
	"closed",
	"dropped",
] as const;

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
	"admit",
	"holder",
	"plan_checkpoint",
	"merged",
	"verdicts",
	"released",
	"left_status",
	"unheld",
] as const;
export type IssueGuard = (typeof ISSUE_GUARDS)[number];

/** Filing an issue at `open`, and promoting a `draft` there, need this; without it an issue is
 *  born at `draft`. */
export const ISSUE_ADMIT_PERMISSION = "issues.admit";

const MOVE = "project.write";

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
	shapes: ["853ac6ba"],
	design: { flow: "issue-lifecycle", revision: 8 },
	states: ISSUE_STATUSES,
	initial: ISSUE_INITIAL_STATUSES,
	terminal: ISSUE_TERMINAL_STATUSES,
	reasonRequired: REASON_REQUIRED_STATUSES,
	edges: [
		{ from: "draft", to: "open", act: "admitted", permission: ISSUE_ADMIT_PERMISSION, guards: ["admit"] },
		{ from: "draft", to: "dropped", act: "not.work", permission: MOVE, guards: [] },

		{ from: "open", to: "in_progress", act: "run.claimed", permission: MOVE, guards: ["holder"] },
		...sideExits("open"),

		{ from: "reopen", to: "in_progress", act: "run.claimed", permission: MOVE, guards: ["holder"] },
		...sideExits("reopen"),

		{ from: "in_progress", to: "approved", act: "plan.recorded", permission: MOVE, guards: ["plan_checkpoint"] },
		{ from: "in_progress", to: "awaiting_release", act: "merged.and.proven", permission: MOVE, guards: ["merged", "verdicts"] },
		...sideExits("in_progress"),

		{ from: "approved", to: "in_progress", act: "run.claimed", permission: MOVE, guards: ["holder"] },
		...sideExits("approved"),

		{ from: "awaiting_release", to: "closed", act: "release.recorded", permission: MOVE, guards: ["released", "merged"] },
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

/** How a move reads against the status it is offered from. */
const ISSUE_MOVE_KINDS = ["forward", "bounce", "discard"] as const;
export type IssueMoveKind = (typeof ISSUE_MOVE_KINDS)[number];

export interface IssueMove {
	to: IssueStatus;
	kind: IssueMoveKind;
	/** First of its kind after another kind: a menu draws a rule above it. */
	startsGroup: boolean;
	/** The machine refuses this move without a reason. */
	needsReason: boolean;
}

const BOUNCE_TARGETS: readonly IssueStatus[] = ["needs_info", "on_hold", "reopen"];
const DISCARD_TARGETS = ISSUE_TERMINAL_STATUSES;

/**
 * The moves a person may offer from a status, read off the machine in the order it declares them:
 * a park's return to the status it left first (every parkable status when none is recorded), then
 * the status's own exits. The first move is the forward one, then the bounces, then the discards.
 */
export function issueMovesFrom(
	from: IssueStatus,
	leftStatus: IssueStatus | null,
): IssueMove[] {
	const returns = ISSUE_MACHINE.edges
		.filter((e) => e.from === from && e.guards.includes("left_status"))
		.map((e) => e.to);
	const back = leftStatus ? returns.filter((to) => to === leftStatus) : returns;
	const rest = ISSUE_MACHINE.edges
		.filter((e) => e.from === from && !e.recovery && !e.guards.includes("left_status"))
		.map((e) => e.to);
	const targets = [...new Set([...back, ...rest])];
	const kindOf = (to: IssueStatus, i: number): IssueMoveKind => {
		if (i === 0 || back.includes(to)) return "forward";
		if (BOUNCE_TARGETS.includes(to)) return "bounce";
		if (DISCARD_TARGETS.includes(to)) return "discard";
		return "forward";
	};
	const typed = targets.map((to, i) => ({ to, kind: kindOf(to, i) }));
	const reason: readonly string[] = ISSUE_MACHINE.reasonRequired;
	const out: IssueMove[] = [];
	for (const kind of ISSUE_MOVE_KINDS) {
		let first = true;
		for (const t of typed) {
			if (t.kind !== kind) continue;
			out.push({ ...t, startsGroup: first && out.length > 0, needsReason: reason.includes(t.to) });
			first = false;
		}
	}
	return out;
}

/** The dependency kind whose live edge out of an issue waives that issue's work-evidence gate. */
export const WORK_EVIDENCE_WAIVER_KIND = "decomposes" as const;

export const WORK_EVIDENCE_WAIVER_NOTE =
	`It does not gate dispatch, but it is NOT inert: one live \`${WORK_EVIDENCE_WAIVER_KIND}\` edge ` +
	"OUT of an issue waives that issue's work-evidence gate, so it can be marked merged and moved " +
	"to a test step with no branch, no commit and no code handoff of its own. That " +
	"exemption exists for grouping parents whose children carry the code; wiring one onto an issue " +
	"that is meant to prove its own work removes the check that would have caught a fabricated " +
	"merge.";
