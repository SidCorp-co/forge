// The suggestion machine: workflow `suggestion-lifecycle`, approved revision 9. Its accept is judged
// by the breakdown checklist (Requirement lifecycle r15 breakdown_check), whose questions are asked
// only of a breakdown.

import { BREAKDOWN_CHECKLIST } from "./checklist-registry.js";
import { CHECKLIST_GUARD } from "./checklists.js";
import { defineMachine } from "./state-machine.js";
import { SUGGESTION_STATUSES } from "./suggestions.js";

export const SUGGESTION_MACHINE = defineMachine({
	entity: "suggestion",
	shapes: ["a6ba4087", "7e48a7d4"],
	design: { flow: "suggestion-lifecycle", revision: 9 },
	states: SUGGESTION_STATUSES,
	initial: ["proposed"],
	terminal: ["accepted", "rejected", "stale", "withdrawn"],
	reasonRequired: ["rejected"],
	edges: [
		{ from: "proposed", to: "accepted", act: "suggestion.accepted", permission: "suggestions.approve", guards: [CHECKLIST_GUARD], checklist: BREAKDOWN_CHECKLIST.id },
		{ from: "proposed", to: "rejected", act: "suggestion.rejected", permission: "suggestions.approve", guards: [] },
		{ from: "proposed", to: "stale", act: "target.revised", permission: null, guards: [] },
		{ from: "proposed", to: "withdrawn", act: "suggestion.withdrawn", permission: null, guards: [] },
	],
});
