// The pipeline-run machine. No state design is drawn for pipeline runs; `agent-run-standing`
// (approved revision 1) reads a run's standing from it.

import { defineMachine, fromEach } from "./state-machine.js";

export const PIPELINE_RUN_STATUSES = [
	"running",
	"paused",
	"completed",
	"failed",
	"cancelled",
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

/** The run is open: work may still be dispatched under it. */
export const OPEN_RUN_STATUSES: readonly PipelineRunStatus[] = ["running", "paused"];

export const TERMINAL_RUN_STATUSES: readonly PipelineRunStatus[] = [
	"completed",
	"failed",
	"cancelled",
];

export const RUN_MACHINE = defineMachine({
	entity: "run",
	design: null,
	states: PIPELINE_RUN_STATUSES,
	initial: ["running"],
	terminal: TERMINAL_RUN_STATUSES,
	reasonRequired: [],
	edges: [
		{ from: "running", to: "paused", act: "run.paused", permission: "runs.pause", guards: [] },
		{ from: "paused", to: "running", act: "run.resumed", permission: "runs.pause", guards: [] },
		...fromEach(OPEN_RUN_STATUSES, "completed", { act: "run.completed", permission: null, guards: [] }),
		...fromEach(OPEN_RUN_STATUSES, "failed", { act: "run.failed", permission: null, guards: [] }),
		...fromEach(OPEN_RUN_STATUSES, "cancelled", { act: "run.cancelled", permission: "runs.cancel", guards: [] }),
	],
});

/** How a one-shot run closes from what its sessions did: none completed or failed means it was
 *  stopped, so `cancelled`, never a failure and never work done. */
export function oneShotRunOutcome(read: {
	anyCompleted: boolean;
	anyFailed: boolean;
}): "completed" | "failed" | "cancelled" {
	if (read.anyFailed) return "failed";
	return read.anyCompleted ? "completed" : "cancelled";
}
