// The skill reconcile-run machine. No state design is drawn for it.

import { defineMachine, fromEach } from "./state-machine.js";

export const RECONCILE_RUN_STATUSES = [
	"pending",
	"running",
	"verifying",
	"decided",
	"applied",
	"escalated",
	"failed",
] as const;
export type ReconcileRunStatus = (typeof RECONCILE_RUN_STATUSES)[number];

const LIVE: readonly ReconcileRunStatus[] = ["pending", "running", "verifying", "decided"];

export const RECONCILE_RUN_MACHINE = defineMachine({
	entity: "reconcile_run",
	shapes: ["1055d915"],
	design: null,
	states: RECONCILE_RUN_STATUSES,
	initial: ["pending"],
	terminal: ["applied", "escalated", "failed"],
	reasonRequired: [],
	edges: [
		...fromEach(["pending", "running"] as const, "verifying", { act: "candidate.proposed", permission: null, guards: [] }),
		...fromEach(["pending", "running", "verifying", "decided"] as const, "applied", { act: "candidate.applied", permission: null, guards: [] }),
		{ from: "verifying", to: "decided", act: "verifier.passed", permission: null, guards: [] },
		...fromEach(LIVE, "escalated", { act: "reconcile.escalated", permission: null, guards: [] }),
		...fromEach(["pending", "running", "verifying"] as const, "failed", { act: "reconcile.failed", permission: null, guards: [] }),
	],
});
