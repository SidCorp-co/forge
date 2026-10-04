// The mockup machine. No state design is drawn for mockups.

import { MOCKUP_STATUSES } from "./mockups.js";
import { defineMachine } from "./state-machine.js";

export const MOCKUP_MACHINE = defineMachine({
	entity: "mockup",
	shapes: ["2e89f76b"],
	design: null,
	states: MOCKUP_STATUSES,
	initial: ["proposed"],
	terminal: ["accepted", "returned", "withdrawn"],
	reasonRequired: ["returned"],
	edges: [
		{ from: "proposed", to: "accepted", act: "mockup.accepted", permission: "mockups.approve", guards: [] },
		{ from: "proposed", to: "returned", act: "mockup.returned", permission: "mockups.approve", guards: [] },
		{ from: "proposed", to: "withdrawn", act: "mockup.withdrawn", permission: null, guards: [] },
	],
});
