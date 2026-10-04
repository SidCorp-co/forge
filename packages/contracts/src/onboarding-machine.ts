// The questionnaire machine (workflow `project-onboarding`, approved revision 1, draws it as steps,
// not as a state design). An onboarding's status is read, not moved: `core/src/onboarding/read.ts:onboardingStatusOf`.

import { QUESTIONNAIRE_STATUSES } from "./onboarding.js";
import { defineMachine, fromEach } from "./state-machine.js";

export const QUESTIONNAIRE_MACHINE = defineMachine({
	entity: "questionnaire",
	design: null,
	states: QUESTIONNAIRE_STATUSES,
	initial: ["open"],
	terminal: ["submitted", "superseded"],
	reasonRequired: ["superseded"],
	edges: [
		...fromEach(["open", "skipped"] as const, "submitted", { act: "questionnaire.submitted", permission: null, guards: [] }),
		{ from: "open", to: "skipped", act: "questionnaire.skipped", permission: null, guards: [] },
		...fromEach(["open", "skipped"] as const, "superseded", { act: "questionnaire.superseded", permission: null, guards: [] }),
	],
});
