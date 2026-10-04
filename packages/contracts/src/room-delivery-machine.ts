// The delivery machine of a chat room: an agent question's round posted into the room its project
// is bound to. No state design is drawn for it; each row is claimed by one core instance, which
// settles it once the room answered.

import { defineMachine } from "./state-machine.js";

export const QUESTION_DELIVERY_STATUSES = [
	"claimed",
	"delivered",
	"undeliverable",
] as const;
export type QuestionDeliveryStatus =
	(typeof QUESTION_DELIVERY_STATUSES)[number];

export const QUESTION_DELIVERY_MACHINE = defineMachine({
	entity: "question_delivery",
	shapes: ["54b4c260"],
	design: null,
	states: QUESTION_DELIVERY_STATUSES,
	initial: ["claimed"],
	terminal: ["delivered"],
	reasonRequired: [],
	edges: [
		{
			from: "claimed",
			to: "claimed",
			act: "question.deliveryReclaimed",
			permission: null,
			guards: [],
		},
		{
			from: "undeliverable",
			to: "claimed",
			act: "question.deliveryReclaimed",
			permission: null,
			guards: [],
		},
		{
			from: "claimed",
			to: "delivered",
			act: "question.delivered",
			permission: null,
			guards: [],
		},
		{
			from: "claimed",
			to: "undeliverable",
			act: "question.undeliverable",
			permission: null,
			guards: [],
		},
	],
});
