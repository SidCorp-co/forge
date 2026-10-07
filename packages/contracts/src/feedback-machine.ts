// The feedback machine: workflow `feedback-lifecycle`, approved revision 9. `planned` and
// `resolved` are phases read from a triaged item's route, never stored.

import { FEEDBACK_STATUSES } from "./feedback.js";
import { defineMachine, fromEach } from "./state-machine.js";

export const FEEDBACK_MACHINE = defineMachine({
	entity: "feedback",
	shapes: ["a2122359", "e469bebc", "7c86963a"],
	design: { flow: "feedback-lifecycle", revision: 9 },
	states: FEEDBACK_STATUSES,
	initial: ["new"],
	terminal: ["verified", "declined"],
	reasonRequired: ["declined", "reopened"],
	edges: [
		...fromEach(["new", "reopened"] as const, "triaged", { act: "feedback.triaged", permission: "feedback.approve", guards: [] }),
		...fromEach(["new", "triaged", "reopened"] as const, "declined", { act: "feedback.declined", permission: "feedback.approve", guards: [] }),
		{ from: "triaged", to: "verified", act: "reporter.verified", permission: "feedback.approve", guards: [] },
		{ from: "triaged", to: "reopened", act: "reporter.reopened", permission: null, guards: [] },
	],
});
