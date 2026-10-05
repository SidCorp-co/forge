// The requirement machine: workflow `requirement-lifecycle`, approved revision 4. `in_delivery`
// and `delivered` are phases read from the linked issues, never stored; revisions carry their own
// state beside it (`requirement_revisions.state`).

import { REQUIREMENT_STATUSES } from "./requirements.js";
import { defineMachine, fromEach } from "./state-machine.js";

export const REQUIREMENT_MACHINE = defineMachine({
	entity: "requirement",
	shapes: ["7bf2075a"],
	design: { flow: "requirement-lifecycle", revision: 4 },
	states: REQUIREMENT_STATUSES,
	initial: ["draft"],
	terminal: ["dropped"],
	reasonRequired: ["dropped", "deferred"],
	edges: [
		{ from: "draft", to: "agreed", act: "requirement.agreed", permission: "requirements.approve", guards: [] },
		{ from: "agreed", to: "accepted", act: "requirement.accepted", permission: "requirements.approve", guards: [] },
		{ from: "accepted", to: "agreed", act: "requirement.revised", permission: "requirements.approve", guards: [] },
		...fromEach(["draft", "agreed"] as const, "deferred", { act: "requirement.deferred", permission: "requirements.write", guards: [] }),
		{ from: "deferred", to: "draft", act: "requirement.undeferred", permission: "requirements.write", guards: [] },
		{ from: "deferred", to: "agreed", act: "requirement.undeferred", permission: "requirements.write", guards: [] },
		...fromEach(["draft", "agreed", "deferred"] as const, "dropped", { act: "requirement.dropped", permission: "requirements.write", guards: [] }),
	],
});
