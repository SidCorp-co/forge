// The requirement machine: workflow `requirement-lifecycle`, approved revision 11. `in_delivery`
// and `delivered` are phases read from the linked issues, never stored; revisions carry their own
// state beside it (`requirement_revisions.state`). The agree and the accept are judged by the
// ready and acceptance checklists of revision 15 (`checklist-registry.ts`); its waiting states
// (Waiting for agreement, Waiting for acceptance) are the stored draft and agreed, held by the
// project's `approvals` switch (`person-gates.ts`), so no state is added.

import {
	REQUIREMENT_ACCEPTANCE_CHECKLIST,
	REQUIREMENT_READY_CHECKLIST,
} from "./checklist-registry.js";
import { CHECKLIST_GUARD } from "./checklists.js";
import { REQUIREMENT_STATUSES } from "./requirements.js";
import { defineMachine, fromEach } from "./state-machine.js";

export const REQUIREMENT_MACHINE = defineMachine({
	entity: "requirement",
	shapes: ["7bf2075a", "96abf038", "4befa9c4"],
	design: { flow: "requirement-lifecycle", revision: 11 },
	states: REQUIREMENT_STATUSES,
	initial: ["draft"],
	terminal: ["dropped"],
	reasonRequired: ["dropped", "deferred"],
	edges: [
		{ from: "draft", to: "agreed", act: "requirement.agreed", permission: "requirements.approve", guards: [CHECKLIST_GUARD], checklist: REQUIREMENT_READY_CHECKLIST.id },
		{ from: "agreed", to: "accepted", act: "requirement.accepted", permission: "requirements.approve", guards: [CHECKLIST_GUARD], checklist: REQUIREMENT_ACCEPTANCE_CHECKLIST.id },
		{ from: "accepted", to: "agreed", act: "requirement.revised", permission: "requirements.approve", guards: [] },
		...fromEach(["draft", "agreed"] as const, "deferred", { act: "requirement.deferred", permission: "requirements.approve", guards: [] }),
		{ from: "deferred", to: "draft", act: "requirement.undeferred", permission: "requirements.approve", guards: [] },
		{ from: "deferred", to: "agreed", act: "requirement.undeferred", permission: "requirements.approve", guards: [] },
		...fromEach(["draft", "agreed", "deferred"] as const, "dropped", { act: "requirement.dropped", permission: "requirements.approve", guards: [] }),
	],
});
