import type { REGISTRY_ISSUE_STATUSES } from "./pipeline-registry.js";

/** The ten statuses of workflow `issue-lifecycle` (ISS-54), named the same on every surface. */
export type KernelIssueStatus = (typeof REGISTRY_ISSUE_STATUSES)[number];

/** A run's steps, in order: core's `workSteps`, held equal by core's `pipeline/registry.test.ts`. */
export const WORK_STEPS = [
	"triage",
	"clarify",
	"plan",
	"build",
	"test",
	"release",
] as const;
export type WorkStep = (typeof WORK_STEPS)[number];

export const WORK_STEP_LABELS: Record<WorkStep, string> = {
	triage: "Triage",
	clarify: "Clarify",
	plan: "Plan",
	build: "Build",
	test: "Test",
	release: "Release",
};

/** Each status as a person reads it — the badge legend's labels, one map for every surface. */
export const ISSUE_STATUS_LABELS: Record<KernelIssueStatus, string> = {
	draft: "Draft",
	open: "Open",
	reopen: "Reopened",
	in_progress: "In progress",
	approved: "Approved",
	needs_info: "Needs info",
	on_hold: "On hold",
	awaiting_release: "Awaiting release",
	closed: "Closed",
	dropped: "Dropped",
};

/** The badge legend: `you` waits on a person, `run` a run holds it, `ready` a master may take it,
 *  `done` it is over, `err` it came back, `neutral` it is not moving. */
export type IssueStatusTone =
	| "neutral"
	| "ready"
	| "run"
	| "you"
	| "done"
	| "err";

export const ISSUE_STATUS_TONES: Record<KernelIssueStatus, IssueStatusTone> = {
	draft: "neutral",
	open: "neutral",
	reopen: "err",
	in_progress: "run",
	approved: "ready",
	needs_info: "you",
	on_hold: "neutral",
	awaiting_release: "you",
	closed: "done",
	dropped: "done",
};

/** Who each status waits on, in the legend's words: the tooltip a badge carries. */
export const ISSUE_STATUS_HINTS: Record<KernelIssueStatus, string> = {
	draft: "draft: not accepted as work yet; a person decides",
	open: "open: accepted, no run yet; a master takes it",
	reopen: "reopen: sent back with a reason; a master takes it again",
	in_progress: "in_progress: a run holds it; its step is the progress",
	approved:
		"approved: the plan checkpoint; the next run goes straight to build",
	needs_info: "needs_info: waiting on a person to answer",
	on_hold: "on_hold: deliberately paused",
	awaiting_release:
		"awaiting_release: every criterion passed; waiting for the release",
	closed: "closed: shipped",
	dropped: "dropped: will not be done",
};

/** status-tuple: differs — core's ISSUE_TERMINAL_STATUSES (the issue is over), bound by db/status-sets-parity.test.ts */
export const DONE_ISSUE_STATUSES: readonly KernelIssueStatus[] = [
	"closed",
	"dropped",
];

/** status-tuple: differs — core's PARK_STATUSES (stopped on a person); the parity test holds the pair equal */
export const PARKED_ISSUE_STATUSES: readonly KernelIssueStatus[] = [
	"needs_info",
	"on_hold",
];

/** status-tuple: differs — core's PARKABLE_STATUSES, where a park is entered from; state-machine.test.ts checks it */
export const PARKABLE_ISSUE_STATUSES: readonly KernelIssueStatus[] = [
	"open",
	"reopen",
	"in_progress",
	"approved",
	"awaiting_release",
];

/** What a `needs_info` park is stopped on (core's `waitingKinds`). */
export const NEEDS_INFO_KINDS = [
	"needs_answer",
	"needs_decision",
	"needs_resource",
] as const;
export type NeedsInfoKind = (typeof NEEDS_INFO_KINDS)[number];

export const NEEDS_INFO_KIND_LABELS: Record<NeedsInfoKind, string> = {
	needs_answer: "A question",
	needs_decision: "A decision",
	needs_resource: "Something to supply",
};
