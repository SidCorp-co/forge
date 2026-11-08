// The feedback machine: workflow `feedback-lifecycle`, approved revision 14. `planned` and
// `resolved` are phases read from a triaged item's route, never stored. An item is triaged only
// through the triage checklist (`checklist-registry.ts:FEEDBACK_TRIAGE_CHECKLIST`, step triage-check),
// by whoever the project's `approvals.triage` switch asks (ISS-639); a decline stays feedback.approve's.

import { FEEDBACK_TRIAGE_CHECKLIST } from "./checklist-registry.js";
import { CHECKLIST_GUARD } from "./checklists.js";
import { FEEDBACK_STATUSES } from "./feedback.js";
import { defineMachine, fromEach } from "./state-machine.js";

export const FEEDBACK_MACHINE = defineMachine({
	entity: "feedback",
	shapes: ["a2122359", "e469bebc", "7c86963a", "cc2c1b17", "5cebf76f", "9fb27bdd", "db74d2fc"],
	design: { flow: "feedback-lifecycle", revision: 14 },
	states: FEEDBACK_STATUSES,
	initial: ["new"],
	// verified is not terminal (owner 2026-11-08, D5): a verify by ship or on someone's behalf can be
	// wrong, so its reporter, or a holder of feedback.approve, reopens it with a reason
	terminal: ["declined"],
	reasonRequired: ["declined", "reopened"],
	edges: [
		...fromEach(["new", "reopened"] as const, "triaged", { act: "feedback.triaged", permission: "feedback.approve", personGate: "triage", guards: [CHECKLIST_GUARD], checklist: FEEDBACK_TRIAGE_CHECKLIST.id }),
		...fromEach(["new", "triaged", "reopened"] as const, "declined", { act: "feedback.declined", permission: "feedback.approve", guards: [] }),
		{ from: "triaged", to: "verified", act: "reporter.verified", permission: "project.read", guards: [] },
		{ from: "triaged", to: "reopened", act: "reporter.reopened", permission: null, guards: [] },
		{ from: "verified", to: "reopened", act: "reporter.reopened", permission: null, guards: [] },
	],
});
