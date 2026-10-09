// The feedback machine: workflow `feedback-lifecycle`, approved revision 14. `planned` and
// `resolved` are phases read from a triaged item's route, never stored. An item is triaged only
// through the triage checklist (`checklist-registry.ts:FEEDBACK_TRIAGE_CHECKLIST`, step triage-check).

import { FEEDBACK_TRIAGE_CHECKLIST } from "./checklist-registry.js";
import { CHECKLIST_GUARD } from "./checklists.js";
import { FEEDBACK_STATUSES } from "./feedback.js";
import { defineMachine, fromEach } from "./state-machine.js";

export const FEEDBACK_MACHINE = defineMachine({
	entity: "feedback",
	shapes: ["a2122359", "e469bebc", "7c86963a", "cc2c1b17", "5cebf76f"],
	design: { flow: "feedback-lifecycle", revision: 14 },
	states: FEEDBACK_STATUSES,
	initial: ["new"],
	terminal: ["verified", "declined"],
	reasonRequired: ["declined", "reopened"],
	edges: [
		...fromEach(["new", "reopened"] as const, "triaged", { act: "feedback.triaged", permission: "feedback.approve", guards: [CHECKLIST_GUARD], checklist: FEEDBACK_TRIAGE_CHECKLIST.id }),
		...fromEach(["new", "triaged", "reopened"] as const, "declined", { act: "feedback.declined", permission: "feedback.approve", guards: [] }),
		{ from: "triaged", to: "verified", act: "reporter.verified", permission: "project.read", guards: [] },
		{ from: "triaged", to: "reopened", act: "reporter.reopened", permission: null, guards: [] },
	],
});
