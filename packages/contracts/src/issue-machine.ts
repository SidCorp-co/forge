// The issue machine: workflow `issue-lifecycle`, revision 23. A status answers only "who is
// it waiting on"; a run's step is progress inside `in_progress`, kept in `issue_work_state`. A
// landing moves no status: it records the merge, and the agent holding the issue moves it on. Work
// that landed moves to `awaiting_release` without verdicts, which are judged on the release that
// carries it (REQ-45 BC-1, BC-2). An issue closes through a release, or, where its only deliverable
// is a design, once its design revisions are approved (REQ-45 BC-4). A draft opens through the
// issue-ready checklist (`checklist-registry.ts:ISSUE_READY_CHECKLIST`). A reopen a requirement-level
// fail made goes back to the status it came from once that fail is routed past the issue (ISS-760).

import { ISSUE_READY_CHECKLIST } from "./checklist-registry.js";
import { CHECKLIST_GUARD } from "./checklists.js";
import type { Refusal, RefusalStatuses } from "./refusal.js";
import { defineMachine, fromEach, type MachineEdge } from "./state-machine.js";

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
	"NOT_THE_HOLDER",
	"ISSUE_BLOCKED",
	"WORKFLOW_DESIGN_NOT_APPROVED",
	"CONTRACT_WAIT_UNSETTLED",
	"PATTERN_REVIEW_PENDING",
	"PATTERN_RETURNED",
	"PATTERN_ENTRY_MISSING",
	"PLAN_REQUIRED",
	"DESIGN_RECORD_MISSING",
	"DESIGN_RECORD_INCOMPLETE",
	"PERMISSION_FORBIDDEN",
	"MERGE_NOT_RECORDED",
	"MERGE_DESIGN_ONLY",
	"CLOSE_REQUIRES_SHIPPED",
	"CLOSE_ONLY_BY_RELEASE",
	"DESIGN_NOT_DELIVERED",
	"TRANSITION_REASON_REQUIRED",
	"WAITING_KIND_REQUIRED",
	"VOID_REASON_REQUIRED",
	"NO_OP",
	"STALE_TRANSITION",
	"WAITING_KIND_NOT_APPLICABLE",
	"NEEDS_NOT_APPLICABLE",
	"ISSUE_ARCHIVED",
	"OPEN_QUESTIONS",
	"CHECKLIST_INCOMPLETE",
	"CHECKLIST_ANSWER_INVALID",
	"ISSUE_REOPEN_RELEASING",
	/** The move back from `reopen` (ISS-760): its reopen was not a requirement-level fail's. */
	"REOPEN_NOT_BY_REQUIREMENT_FAIL",
	/** The move back from `reopen`: one of its own criteria tracing the failed BC does not pass. */
	"REOPEN_CRITERIA_NOT_PASSING",
	/** The move back from `reopen`: no other issue owns what the failed BC lacks. */
	"REOPEN_FAIL_UNOWNED",
	/** A body key the move does not take, `note` among them: named, with the keys it does (ISS-566). */
	"TRANSITION_FIELD_UNKNOWN",
] as const;
export type IssueTransitionRefusalCode =
	(typeof ISSUE_TRANSITION_REFUSAL_CODES)[number];
export const ISSUE_TRANSITION_REFUSAL_STATUSES = {
	NO_HOLDER: 409,
	NOT_THE_HOLDER: 403,
	STALE_TRANSITION: 409,
	CHECKLIST_ANSWER_INVALID: 400,
	ISSUE_REOPEN_RELEASING: 409,
	TRANSITION_FIELD_UNKNOWN: 400,
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
export const ISSUE_INITIAL_STATUSES = [
	"draft",
	"open",
] as const satisfies readonly IssueStatus[];

/** Entering one of these carries the actor's reason. */
export const REASON_REQUIRED_STATUSES = [
	"reopen",
	"needs_info",
	"on_hold",
	"dropped",
] as const;

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
export const ISSUE_TERMINAL_STATUSES: readonly IssueStatus[] = [
	"closed",
	"dropped",
];

/**
 * An issue AT REST: over, or parked on a person. No run takes one, so a run declared to take one is
 * refused at declare (`issues/issue-resting.ts`; a run over issues all over takes nothing and
 * opens, ISS-576), and a run holding one is a stale declaration in core's recovery verdict
 * (`devices/run-verdict.ts:staleEnd`). One list, so the two never disagree about which statuses
 * those are (FB-273).
 */
export const ISSUE_RESTING_STATUSES: readonly IssueStatus[] = [
	...ISSUE_TERMINAL_STATUSES,
	...PARK_STATUSES,
];

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
export const TAKEABLE_STATUSES: readonly IssueStatus[] = [
	"open",
	"approved",
	"reopen",
];

/** Stopped until a person answers: what Needs you and the park view both count. */
export const AWAITING_INPUT_STATUSES: readonly IssueStatus[] = ["needs_info"];

/** A run is working it right now; its step is on `issue_work_state`. */
export const ASSERTS_WORK_IN_PROGRESS: readonly IssueStatus[] = ["in_progress"];

/** Nothing is left to do on it: a job that failed against it no longer matters, and a `blocks`
 *  edge onto it is settled. */
export const ISSUE_RESOLVED_STATUSES: readonly IssueStatus[] = [
	"awaiting_release",
	"closed",
];

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
	"design",
	"merged",
	"released",
	"left_status",
	"unheld",
	"run_holder",
	"design_delivered",
	"not_releasing",
	"fail_routed",
] as const;
export type IssueGuard = (typeof ISSUE_GUARDS)[number];

/** Filing an issue at `open`, and promoting a `draft` there, need this; without it an issue is
 *  born at `draft`. */
export const ISSUE_ADMIT_PERMISSION = "issues.admit";

const MOVE = "project.write";

/** Where a design-only issue may close from once its design revisions are approved: every live
 *  status but the two parks, which return only to the status they left, cross or drop (REQ-2 BC-9),
 *  `awaiting_release`, whose own edge to `closed` takes that delivery too, and `reopen`, whose
 *  edge to `closed` is the way back (`fail_routed`), which takes it too. */
const DESIGN_CLOSABLE_STATUSES: readonly IssueStatus[] = [
	"draft",
	"open",
	"in_progress",
	"approved",
];

type IssueEdge = MachineEdge<IssueStatus> & {
	readonly guards: readonly (IssueGuard | typeof CHECKLIST_GUARD)[];
};

const sideExits = (from: IssueStatus): IssueEdge[] => [
	{
		from,
		to: "needs_info",
		act: "question.asked",
		permission: MOVE,
		guards: [],
	},
	{ from, to: "on_hold", act: "paused", permission: MOVE, guards: [] },
	{ from, to: "dropped", act: "not.work", permission: MOVE, guards: [] },
];

/** A park returns to the status it left; `left_status` refuses any other of these. */
const parkReturns = (from: IssueStatus, act: string): IssueEdge[] =>
	PARKABLE_STATUSES.map((to) => ({
		from,
		to,
		act,
		permission: MOVE,
		guards: ["left_status"],
	}));

const recovery = (
	to: IssueStatus,
	guards: readonly IssueGuard[],
): IssueEdge => ({
	from: "in_progress",
	to,
	act: "handed.back",
	permission: MOVE,
	guards: ["unheld", ...guards],
	recovery: true,
});

export const ISSUE_MACHINE = defineMachine({
	entity: "issue",
	shapes: [
		"853ac6ba",
		"23991d04",
		"5a3cd8b3",
		"07fda5db",
		"89cf83a7",
		"9ee504ee",
		"d0460eb0",
		"011aa9bf",
	],
	design: { flow: "issue-lifecycle", revision: 23 },
	states: ISSUE_STATUSES,
	initial: ISSUE_INITIAL_STATUSES,
	terminal: ISSUE_TERMINAL_STATUSES,
	reasonRequired: REASON_REQUIRED_STATUSES,
	edges: [
		{
			from: "draft",
			to: "open",
			act: "admitted",
			permission: ISSUE_ADMIT_PERMISSION,
			guards: ["admit", CHECKLIST_GUARD],
			checklist: ISSUE_READY_CHECKLIST.id,
		},
		{
			from: "draft",
			to: "dropped",
			act: "not.work",
			permission: MOVE,
			guards: [],
		},

		{
			from: "open",
			to: "in_progress",
			act: "run.claimed",
			permission: MOVE,
			guards: ["holder"],
		},
		...sideExits("open"),

		{
			from: "reopen",
			to: "in_progress",
			act: "run.claimed",
			permission: MOVE,
			guards: ["holder"],
		},
		...sideExits("reopen"),
		// back the way it came: a requirement-level fail routed past the issue since it reopened it
		// (ISS-760); to `closed`, a design-only issue's delivered design closes it here too
		{
			from: "reopen",
			to: "awaiting_release",
			act: "fail.routed",
			permission: MOVE,
			guards: ["fail_routed", "merged"],
		},
		{
			from: "reopen",
			to: "closed",
			act: "fail.routed",
			permission: MOVE,
			guards: ["fail_routed", "merged"],
		},

		{
			from: "in_progress",
			to: "approved",
			act: "plan.recorded",
			permission: MOVE,
			guards: ["plan_checkpoint", "design"],
		},
		{
			from: "in_progress",
			to: "awaiting_release",
			act: "merged",
			permission: MOVE,
			guards: ["run_holder", "merged"],
		},
		...sideExits("in_progress"),

		{
			from: "approved",
			to: "in_progress",
			act: "run.claimed",
			permission: MOVE,
			guards: ["holder"],
		},
		...sideExits("approved"),

		{
			from: "awaiting_release",
			to: "closed",
			act: "release.recorded",
			permission: MOVE,
			guards: ["released", "merged"],
		},
		{
			from: "awaiting_release",
			to: "reopen",
			act: "release.failed",
			permission: MOVE,
			guards: ["not_releasing"],
		},
		...sideExits("awaiting_release"),

		...parkReturns("needs_info", "answered"),
		{
			from: "needs_info",
			to: "on_hold",
			act: "paused",
			permission: MOVE,
			guards: [],
		},
		{
			from: "needs_info",
			to: "dropped",
			act: "not.work",
			permission: MOVE,
			guards: [],
		},

		...parkReturns("on_hold", "lifted"),
		{
			from: "on_hold",
			to: "needs_info",
			act: "question.asked",
			permission: MOVE,
			guards: [],
		},
		{
			from: "on_hold",
			to: "dropped",
			act: "not.work",
			permission: MOVE,
			guards: [],
		},

		{
			from: "closed",
			to: "reopen",
			act: "returned",
			permission: MOVE,
			guards: [],
		},

		// a design-only issue's deliverable is its approved design revisions: it closes on them, and
		// from awaiting_release the `released` guard takes the same delivery as its release
		...fromEach(DESIGN_CLOSABLE_STATUSES, "closed", {
			act: "design.delivered",
			permission: MOVE,
			guards: ["design_delivered", "merged"],
		}),

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

const BOUNCE_TARGETS: readonly IssueStatus[] = [
	"needs_info",
	"on_hold",
	"reopen",
];
const DISCARD_TARGETS = ISSUE_TERMINAL_STATUSES;

/**
 * The moves a person may offer from a status, read off the machine in the order it declares them:
 * a park's return to the status it left first (every parkable status when none is recorded), then
 * the status's own exits. The first move is the forward one, then the bounces, then the discards.
 * The design-only close is offered only where the issue's merge mark is design-only (`designOnly`);
 * its guard still asks that the revisions are approved.
 * The way back from a requirement-level fail's reopen (`fail_routed`) is not offered: the menu
 * cannot read the fail, and the move is made through the transition door.
 */
export function issueMovesFrom(
	from: IssueStatus,
	leftStatus: IssueStatus | null,
	designOnly: boolean,
): IssueMove[] {
	const returns = ISSUE_MACHINE.edges
		.filter((e) => e.from === from && e.guards.includes("left_status"))
		.map((e) => e.to);
	const back = leftStatus ? returns.filter((to) => to === leftStatus) : returns;
	const rest = ISSUE_MACHINE.edges
		.filter(
			(e) =>
				e.from === from && !e.recovery && !e.guards.includes("left_status"),
		)
		.filter((e) => designOnly || !e.guards.includes("design_delivered"))
		// the way back from a reopen reads a requirement fail no menu holds: only the design-only
		// close it also carries is offered, to a design-only issue (ISS-760)
		.filter(
			(e) =>
				!e.guards.includes("fail_routed") || (designOnly && e.to === "closed"),
		)
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
			out.push({
				...t,
				startsGroup: first && out.length > 0,
				needsReason: reason.includes(t.to),
			});
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
