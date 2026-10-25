// The requirement machine: workflow `requirement-lifecycle`, approved revision 11, with in_delivery
// and delivered stored (REQ-74 BC-8): every status is moved by an explicit act of a person, the
// assistant or an agent, and none is read off the linked issues or verdicts. Revisions carry their
// own state beside it (`requirement_revisions.state`). The agree and the accept are judged by the
// ready and acceptance checklists of revision 15 (`checklist-registry.ts`); its waiting states
// (Waiting for agreement, Waiting for acceptance) are the stored draft and delivered, held by the
// project's `approvals` switch (`person-gates.ts`), so no state is added. The move into delivery and
// the move to delivered are judged by their own guards (`move-gates.ts`).

import {
	REQUIREMENT_ACCEPTANCE_CHECKLIST,
	REQUIREMENT_READY_CHECKLIST,
} from "./checklist-registry.js";
import { CHECKLIST_GUARD } from "./checklists.js";
import { DELIVERING_STATUSES, REQUIREMENT_STATUSES } from "./requirements.js";

import { defineMachine, fromEach } from "./state-machine.js";

/** The guard of agreed → in_delivery: a live issue is linked (REQUIREMENT_NO_LIVE_ISSUE). */
export const REQUIREMENT_HAS_LIVE_ISSUE_GUARD = "requirement_has_live_issue";
/** The guard of in_delivery → delivered: every live criterion passes on the running build (REQUIREMENT_CRITERIA_UNPROVEN). */
export const REQUIREMENT_CRITERIA_PROVEN_GUARD = "requirement_criteria_proven";

export const REQUIREMENT_MACHINE = defineMachine({
	entity: "requirement",
	shapes: ["7bf2075a", "96abf038", "4befa9c4", "5a00cd50", "e8899387", "2b612d32"],
	design: { flow: "requirement-lifecycle", revision: 11 },
	states: REQUIREMENT_STATUSES,
	initial: ["draft"],
	terminal: ["dropped"],
	reasonRequired: ["dropped", "deferred", "refused"],
	edges: [
		// approvals.agree and approvals.accept off (the default): project.write moves them (REQ-4 BC-16 r6)
		{ from: "draft", to: "agreed", act: "requirement.agreed", permission: "requirements.approve", personGate: "agree", guards: [CHECKLIST_GUARD], checklist: REQUIREMENT_READY_CHECKLIST.id },
		{ from: "agreed", to: "in_delivery", act: "requirement.deliveryStarted", permission: "requirements.approve", personGate: "accept", guards: [REQUIREMENT_HAS_LIVE_ISSUE_GUARD] },
		{ from: "in_delivery", to: "delivered", act: "requirement.delivered", permission: "requirements.approve", personGate: "accept", guards: [REQUIREMENT_CRITERIA_PROVEN_GUARD] },
		// accepted from any delivering status, judged by the acceptance checklist; an accept by
		// decision waives its blocking items, each recorded on the move
		...fromEach(DELIVERING_STATUSES, "accepted", { act: "requirement.accepted", permission: "requirements.approve", personGate: "accept", guards: [CHECKLIST_GUARD], checklist: REQUIREMENT_ACCEPTANCE_CHECKLIST.id }),
		// a revision accepted over a delivered head re-agrees it, and delivery is moved again
		...fromEach(["in_delivery", "delivered", "accepted"] as const, "agreed", { act: "requirement.revised", permission: "requirements.approve", guards: [] }),
		...fromEach(["draft", "agreed"] as const, "deferred", { act: "requirement.deferred", permission: "requirements.approve", guards: [] }),
		{ from: "deferred", to: "draft", act: "requirement.undeferred", permission: "requirements.approve", guards: [] },
		{ from: "deferred", to: "agreed", act: "requirement.undeferred", permission: "requirements.approve", guards: [] },
		...fromEach(["draft", "agreed", "in_delivery", "deferred"] as const, "dropped", { act: "requirement.dropped", permission: "requirements.approve", guards: [] }),
		// its value check refuses a request with a reason, and a person keeps it with one (REQ-65 BC-2, BC-6)
		{ from: "draft", to: "refused", act: "requirement.refused", permission: null, guards: [] },
		{ from: "refused", to: "draft", act: "requirement.kept", permission: "project.write", guards: [] },
	],
});
