// The suggestion machine: workflow `suggestion-lifecycle`, approved revision 5.

import { defineMachine } from "./state-machine.js";
import { SUGGESTION_STATUSES } from "./suggestions.js";

export const SUGGESTION_MACHINE = defineMachine({
	entity: "suggestion",
	shapes: ["a6ba4087"],
	design: { flow: "suggestion-lifecycle", revision: 5 },
	states: SUGGESTION_STATUSES,
	initial: ["proposed"],
	terminal: ["accepted", "rejected", "stale", "withdrawn"],
	reasonRequired: ["rejected"],
	edges: [
		{ from: "proposed", to: "accepted", act: "suggestion.accepted", permission: "suggestions.approve", guards: [] },
		{ from: "proposed", to: "rejected", act: "suggestion.rejected", permission: "suggestions.approve", guards: [] },
		{ from: "proposed", to: "stale", act: "target.revised", permission: null, guards: [] },
		{ from: "proposed", to: "withdrawn", act: "suggestion.withdrawn", permission: null, guards: [] },
	],
});
