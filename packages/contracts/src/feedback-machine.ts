// The feedback machine: workflow `feedback-lifecycle`, approved revision 2. `planned` and
// `resolved` are phases read from a triaged item's route, never stored.

import { FEEDBACK_STATUSES } from "./feedback.js";
import { defineMachine, fromEach } from "./state-machine.js";

export const FEEDBACK_MACHINE = defineMachine({
	entity: "feedback",
	shapes: ["a2122359"],
	design: { flow: "feedback-lifecycle", revision: 2 },
	states: FEEDBACK_STATUSES,
	initial: ["new"],
	terminal: ["verified", "declined"],
	reasonRequired: ["declined", "reopened"],
	edges: [
		...fromEach(["new", "reopened"] as const, "triaged", { act: "feedback.triaged", permission: "feedback.triage", guards: [] }),
		...fromEach(["new", "triaged", "reopened"] as const, "declined", { act: "feedback.declined", permission: "feedback.triage", guards: [] }),
		...fromEach(["triaged", "reopened"] as const, "verified", { act: "reporter.verified", permission: "feedback.approve", guards: [] }),
		{ from: "triaged", to: "reopened", act: "reporter.reopened", permission: null, guards: [] },
	],
});
