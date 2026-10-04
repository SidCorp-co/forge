// The agent-question machine. No state design is drawn for questions; issue-lifecycle's park
// question rides it.

import { defineMachine, fromEach } from "./state-machine.js";

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
		{ from: "answered", to: "open", act: "question.followed_up", permission: null, guards: [] },
		...fromEach(["open", "answered"] as const, "needs_info", { act: "rounds.exhausted", permission: null, guards: [] }),
		...fromEach(["open", "answered"] as const, "void", { act: "question.voided", permission: null, guards: [] }),
		{ from: "open", to: "expired", act: "park.expired", permission: null, guards: [] },
	],
});
