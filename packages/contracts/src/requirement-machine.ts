// The requirement machine: workflow `requirement-lifecycle`, approved revision 6. `in_delivery`
// and `delivered` are phases read from the linked issues, never stored; revisions carry their own
// state beside it (`requirement_revisions.state`).

import { REQUIREMENT_STATUSES } from "./requirements.js";
import { defineMachine, fromEach } from "./state-machine.js";

export const REQUIREMENT_MACHINE = defineMachine({
	entity: "requirement",
	shapes: ["7bf2075a", "96abf038"],
	design: { flow: "requirement-lifecycle", revision: 6 },
	states: REQUIREMENT_STATUSES,
	initial: ["draft"],
	terminal: ["dropped"],
	reasonRequired: ["dropped", "deferred"],
	edges: [
		{ from: "draft", to: "agreed", act: "requirement.agreed", permission: "requirements.approve", guards: [] },
		{ from: "agreed", to: "accepted", act: "requirement.accepted", permission: "requirements.approve", guards: [] },
		{ from: "accepted", to: "agreed", act: "requirement.revised", permission: "requirements.approve", guards: [] },
		...fromEach(["draft", "agreed"] as const, "deferred", { act: "requirement.deferred", permission: "requirements.approve", guards: [] }),
		{ from: "deferred", to: "draft", act: "requirement.undeferred", permission: "requirements.approve", guards: [] },
		{ from: "deferred", to: "agreed", act: "requirement.undeferred", permission: "requirements.approve", guards: [] },
		...fromEach(["draft", "agreed", "deferred"] as const, "dropped", { act: "requirement.dropped", permission: "requirements.approve", guards: [] }),
	],
});
