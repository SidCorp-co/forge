// The job machine. No state design is drawn for jobs; `agent-run-standing` (approved revision 1)
// reads a job as a run's standing, and the differences are the job's own states below.

import { defineMachine, fromEach } from "./state-machine.js";

export const JOB_STATUSES = [
	"queued",
	"dispatched",
	"running",
	"held",
	"done",
	"failed",
	"cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The job is not over: it holds a runner slot, waits for one, or waits for a person. */
export const LIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "dispatched", "running", "held"];

/** Live and moving: `held` waits on a person or a gate, not on a runner. */
export const UNHELD_LIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "dispatched", "running"];

/** Out with a runner, so it occupies one of that runner's slots. */
export const OCCUPYING_JOB_STATUSES: readonly JobStatus[] = ["dispatched", "running"];

/** Over, whichever exit it took. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["done", "failed", "cancelled"];

export const JOB_MACHINE = defineMachine({
	entity: "job",
	shapes: ["df8e6dc6"],
	design: null,
	states: JOB_STATUSES,
	initial: ["queued", "held"],
	terminal: TERMINAL_JOB_STATUSES,
	reasonRequired: [],
	edges: [
		{ from: "queued", to: "dispatched", act: "lease.taken", permission: null, guards: [] },
		{ from: "held", to: "queued", act: "hold.released", permission: "jobs.resume", guards: [] },
		...fromEach(OCCUPYING_JOB_STATUSES, "done", { act: "run.completed", permission: null, guards: [] }),
		...fromEach(LIVE_JOB_STATUSES, "failed", { act: "run.failed", permission: null, guards: [] }),
		...fromEach(LIVE_JOB_STATUSES, "cancelled", { act: "run.cancelled", permission: "jobs.cancel", guards: [] }),
		// A runner whose completion was lost to an outage finds its job reaped; its late success is kept.
		{ from: "failed", to: "done", act: "late.completed", permission: null, guards: [] },
	],
});
