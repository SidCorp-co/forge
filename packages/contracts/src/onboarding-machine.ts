// The onboarding and questionnaire machines (workflow `project-onboarding`, approved revision 1,
// draws them as steps, not as a state design).

import { ONBOARDING_STATUSES, QUESTIONNAIRE_STATUSES } from "./onboarding.js";
import { defineMachine, fromEach } from "./state-machine.js";

export const ONBOARDING_MACHINE = defineMachine({
	entity: "onboarding",
	design: null,
	states: ONBOARDING_STATUSES,
	initial: ["in_progress"],
	terminal: ["done"],
	reasonRequired: [],
	edges: [
		{ from: "in_progress", to: "waiting_on_you", act: "round.sent", permission: null, guards: [] },
		{ from: "waiting_on_you", to: "in_progress", act: "round.answered", permission: null, guards: [] },
		...fromEach(["in_progress", "waiting_on_you"] as const, "done", { act: "onboarding.done", permission: "onboarding.write", guards: [] }),
		{ from: "done", to: "in_progress", act: "onboarding.reanalyzed", permission: "onboarding.write", guards: [] },
		{ from: "waiting_on_you", to: "in_progress", act: "onboarding.reanalyzed", permission: "onboarding.write", guards: [] },
	],
});

export const QUESTIONNAIRE_MACHINE = defineMachine({
	entity: "questionnaire",
	design: null,
	states: QUESTIONNAIRE_STATUSES,
	initial: ["open"],
	terminal: ["submitted", "superseded"],
	reasonRequired: ["superseded"],
	edges: [
		{ from: "open", to: "submitted", act: "questionnaire.submitted", permission: null, guards: [] },
		{ from: "open", to: "skipped", act: "questionnaire.skipped", permission: null, guards: [] },
		...fromEach(["open", "skipped"] as const, "superseded", { act: "questionnaire.superseded", permission: null, guards: [] }),
	],
});
