// The two status vocabularies a project can be read in.
//
// The kernel has one status enum and it is not changing per project: every
// gate, index and reaper reads `issues.status`. What differs is what a reader
// should be SHOWN. A staged project walks fifteen statuses because a human
// approves at several of them. An autonomous project has seven: six because the
// session owns everything between claim and close, plus `awaiting_release`,
// because merging to the base branch is not shipping and only the release path
// may close an issue from there.
//
// So this is a rendering map, not a second state machine. A label exists here
// only when some kernel status already enforces its rule — `running` is not a
// new state, it is what `in_progress` has always meant. The one status the
// kernel gained for this vocabulary is `dropped`, because closing-without-
// stamping is a rule nothing else enforced; the gate needed no status of its
// own because the release path already parks on `tested`.
//
// Design: docs/modules/issues-pipeline/release-gate.md (the gate),
// docs/proposals/agent-driven-pipeline.md (the mode)

import type { REGISTRY_ISSUE_STATUSES } from "./pipeline-registry.js";

export type KernelIssueStatus = (typeof REGISTRY_ISSUE_STATUSES)[number];

export const AUTONOMOUS_LABELS = [
	"draft",
	"open",
	"running",
	"needs_human",
	"awaiting_release",
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
	// cm:edge contract -> packages/core/src/release-batch/gate.ts — the gate resolver returns `tested` as the park status, and that is the ONLY reason this label writes there; a resolver that parks elsewhere leaves the board naming a status the release path never reads
	awaiting_release: "tested",
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
	released: "running",
	// cm:edge lockstep -> packages/core/src/issues/apply-transition.ts — `reopen` reads as `open` only because the autonomous rewrite lands it there; drop that rewrite and the board shows a queued issue no dispatcher will ever pick up, which is how ISS-141 sat for an hour looking like it was running
	reopen: "open",
	waiting: "needs_human",
	on_hold: "needs_human",
	needs_info: "needs_human",
	closed: "done",
	dropped: "dropped",
};

export function toAutonomousLabel(status: KernelIssueStatus): AutonomousLabel {
	return KERNEL_TO_LABEL[status];
}

/**
 * How to render this project's issues. `mode` comes from
 * `agentConfig.pipelineConfig.mode`; anything other than `autonomous` renders
 * the kernel status as-is, which is what every existing client already does.
 */
export function renderStatus(
	status: KernelIssueStatus,
	mode: string | undefined,
): string {
	return mode === "autonomous" ? toAutonomousLabel(status) : status;
}

/**
 * Read `pipelineConfig.mode` out of a project's untyped `agentConfig`. Anything
 * that is not a string is absent, which renders the kernel vocabulary — the
 * behaviour every client already has.
 */
// cm:guard absent must mean STAGED, never "unknown": a malformed config that relabelled the board would tell an operator their staged project is running a driver it is not
export function readPipelineMode(agentConfig: unknown): string | undefined {
	if (typeof agentConfig !== "object" || agentConfig === null) return undefined;
	const pipeline = (agentConfig as Record<string, unknown>)["pipelineConfig"];
	if (typeof pipeline !== "object" || pipeline === null) return undefined;
	const mode = (pipeline as Record<string, unknown>)["mode"];
	return typeof mode === "string" ? mode : undefined;
}
