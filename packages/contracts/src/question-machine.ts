// The agent-question machine. No state design is drawn for questions; issue-lifecycle's park
// question rides it. `needs_info` is held by rows written before follow-up rounds were removed;
// nothing enters it now.

import { defineMachine } from "./state-machine.js";

export const QUESTION_STATUSES = ["open", "answered", "void", "expired", "needs_info"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const QUESTION_MACHINE = defineMachine({
	entity: "question",
	design: null,
	states: QUESTION_STATUSES,
	initial: ["open"],
	terminal: ["void", "expired", "needs_info"],
	reasonRequired: ["void"],
	edges: [
		{ from: "open", to: "answered", act: "question.answered", permission: null, guards: [] },
		{ from: "open", to: "void", act: "question.voided", permission: null, guards: [] },
		{ from: "open", to: "expired", act: "park.expired", permission: null, guards: [] },
	],
});
