// How a status is read on the board.
//
// The kernel has one status enum and it is not changing: every gate, index and
// reaper reads `issues.status`. What differs is what a reader should be SHOWN.
// The lane has nine labels — six because the session owns everything between
// claim and close, plus `awaiting_release`, because merging to the base branch
// is not shipping and only the release path may close an issue from there, plus
// `paused`, because a pause somebody chose and a question somebody is owed are
// not the same thing to a reader (ISS-970), plus `reopened`, because a close
// somebody disputed is not a queued issue.
//
// So this is a rendering map, not a second state machine. A label exists here
// only when some kernel status already enforces its rule — `running` is not a
// new state, it is what `in_progress` has always meant. The one status the
// kernel gained for this vocabulary is `dropped`, because closing-without-
// stamping is a rule nothing else enforced. `awaiting_release` needed no new
// status either: the kernel status was RENAMED to this label in migration 0228,
// because `released` was the past tense of an action that had not happened.
//
// Design: docs/proposals/agent-driven-pipeline.md

import type { REGISTRY_ISSUE_STATUSES } from "./pipeline-registry.js";

export type KernelIssueStatus = (typeof REGISTRY_ISSUE_STATUSES)[number];

export const AUTONOMOUS_LABELS = [
	"draft",
	"open",
	"running",
	"needs_human",
	"paused",
	"awaiting_release",
	"reopened",
	"done",
	"dropped",
] as const;

export type AutonomousLabel = (typeof AUTONOMOUS_LABELS)[number];

/** The kernel status a label is written as. */
export const LABEL_TO_KERNEL: Record<AutonomousLabel, KernelIssueStatus> = {
	draft: "draft",
	open: "open",
	running: "in_progress",
	needs_human: "needs_info",
	paused: "on_hold",
	awaiting_release: "awaiting_release",
	reopened: "reopen",
	done: "closed",
	dropped: "dropped",
};

const KERNEL_TO_LABEL: Record<KernelIssueStatus, AutonomousLabel> = {
	draft: "draft",
	open: "open",
	confirmed: "running",
	clarified: "running",
	approved: "running",
	in_progress: "running",
	developed: "running",
	testing: "running",
	tested: "awaiting_release",
	awaiting_release: "awaiting_release",
	releasing: "running",
	reopen: "reopened",
	waiting: "needs_human",
	on_hold: "paused",
	needs_info: "needs_human",
	closed: "done",
	dropped: "dropped",
};

export function toAutonomousLabel(status: KernelIssueStatus): AutonomousLabel {
	return KERNEL_TO_LABEL[status];
}

/**
 * How to render an issue's status. There is one lane and therefore one
 * vocabulary — a project does not choose it.
 */
export function renderStatus(status: KernelIssueStatus): string {
	return toAutonomousLabel(status);
}

export function statusesForLabels(
	...labels: AutonomousLabel[]
): KernelIssueStatus[] {
	return (Object.keys(KERNEL_TO_LABEL) as KernelIssueStatus[]).filter((s) =>
		labels.includes(toAutonomousLabel(s)),
	);
}
