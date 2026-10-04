// The schedule fire machine. No state design is drawn for it; workflow `automation` (approved
// revision 1) reads a fire's outcome.

import { SCHEDULE_RUN_STATUSES } from "./schedules.js";
import { defineMachine } from "./state-machine.js";

export const SCHEDULE_RUN_MACHINE = defineMachine({
	entity: "schedule_run",
	design: null,
	states: SCHEDULE_RUN_STATUSES,
	initial: ["running"],
	terminal: ["success", "skipped"],
	reasonRequired: [],
	edges: [
		{ from: "running", to: "success", act: "fire.succeeded", permission: null, guards: [] },
		{ from: "running", to: "failed", act: "fire.failed", permission: null, guards: [] },
		{ from: "running", to: "skipped", act: "fire.skipped", permission: null, guards: [] },
		{ from: "failed", to: "running", act: "fire.retried", permission: null, guards: [] },
	],
});
