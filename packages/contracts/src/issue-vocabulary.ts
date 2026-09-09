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
// stamping is a rule nothing else enforced; the gate needed no status of its
// own because the release path already parks on `released`.
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
	// cm:edge contract -> packages/core/src/release-batch/gate.ts — the gate resolver returns `released` as the park status, and that is the ONLY reason this label writes there; a resolver that parks elsewhere leaves the board naming a status the release path never reads
	awaiting_release: "released",
	reopened: "reopen",
	done: "closed",
	dropped: "dropped",
};

// cm:guard every kernel status must map to SOME label, including the ones the autonomous driver never writes — a staged issue moved onto an autonomous project, or one from before the switch, still has to render as something. A missing entry is a blank cell on the board, not an error anyone sees.
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
	released: "awaiting_release",
	// cm:guard reads as `running`, not `awaiting_release`: a batch is executing, so a board showing it as "awaiting" would invite a person to trigger a release already in flight. `released` is the waiting one and keeps that label.
	releasing: "running",
	// cm:guard a label of its OWN, not `open`: nothing dispatches at `reopen` since the `reopen → open` rewrite was retired 2026-09-10, so rendering it as `open` puts a row on the board that no dispatcher will ever pick up — how epodsystem ISS-141 sat for an hour looking like it was running. It is not `needs_human` either: that label is what `AWAITING_INPUT_STATUSES` copies (me/attention-buckets.ts) and `reopen` is already in that module's `NEEDS_REVIEW_STATUSES`, so folding it in double-counts one issue into two attention buckets.
	reopen: "reopened",
	waiting: "needs_human",
	// cm:guard ISS-970 — `on_hold` is a pause a PERSON chose, never a question waiting on one, and reading it as `needs_human` put a "needs a human" row on the dashboard for every parked issue. `cancel` parks with `parkIssue: true` by default (packages/core/src/pipeline/runs-control.ts), so each duplicate run cancelled minted one false alarm: 3 cancels on 2026-09-07 produced 3 rows and 0 questions. Anything that widens this back also has to answer why `unseenDrafts` in packages/core/src/me/attention-buckets.ts refused the same fold.
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

// cm:guard the only sanctioned way to ask "which statuses mean X" — a caller that hand-writes the tuple instead owns a second copy of this map, and ISS-970 is what that costs: core, the issues list and this file each held their own list of the parked statuses and the list was wrong in two of the three.
// cm:why the source is KERNEL_TO_LABEL's own keys and NOT `REGISTRY_ISSUE_STATUSES`, although that tuple is the enum: a VALUE import of `./pipeline-registry.js` from this file does not resolve under Next/Turbopack (TS source, ESM-style relative specifier) and fails the web-v2 build with `Module not found: ./pipeline-registry.js`, while the type-only import above is erased and fine. The keys are total over the enum by the Record type, which the totality case in the test file asserts against the tuple anyway.
export function statusesForLabels(
	...labels: AutonomousLabel[]
): KernelIssueStatus[] {
	return (Object.keys(KERNEL_TO_LABEL) as KernelIssueStatus[]).filter((s) =>
		labels.includes(toAutonomousLabel(s)),
	);
}
