// The lesson machine (REQ-50, docs/proposals/lessons.md). No state design is drawn for lessons.
// Only an approved lesson reaches an agent; a confusion holds it until a person decides.

import { LESSON_STATUSES } from "./lessons.js";
import { defineMachine } from "./state-machine.js";

export const LESSON_MACHINE = defineMachine({
	entity: "lesson",
	shapes: ["c1d46f15"],
	design: null,
	states: LESSON_STATUSES,
	initial: ["proposed"],
	terminal: ["rejected", "retired"],
	reasonRequired: ["rejected", "held", "retired"],
	edges: [
		{
			from: "proposed",
			to: "approved",
			act: "lesson.approved",
			permission: "suggestions.approve",
			guards: [],
		},
		{
			from: "proposed",
			to: "rejected",
			act: "lesson.rejected",
			permission: "suggestions.approve",
			guards: [],
		},
		{
			from: "approved",
			to: "held",
			act: "lesson.held",
			permission: null,
			guards: [],
		},
		{
			from: "held",
			to: "approved",
			act: "lesson.kept",
			permission: "suggestions.approve",
			guards: [],
		},
		{
			from: "approved",
			to: "retired",
			act: "lesson.retired",
			permission: "suggestions.approve",
			guards: [],
		},
		{
			from: "held",
			to: "retired",
			act: "lesson.retired",
			permission: "suggestions.approve",
			guards: [],
		},
	],
});
