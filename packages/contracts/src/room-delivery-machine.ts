// The two delivery machines of a chat room: an issue comment carried into the room its project is
// bound to, and an agent question's round posted there. No state design is drawn for either; each
// row is claimed by one core instance, which settles it once the room answered.

import { defineMachine } from "./state-machine.js";

export const COMMENT_MIRROR_STATUSES = [
	"claimed",
	"delivered",
	"refused",
] as const;
export type CommentMirrorStatus = (typeof COMMENT_MIRROR_STATUSES)[number];

export const COMMENT_MIRROR_MACHINE = defineMachine({
	entity: "comment_mirror",
	shapes: ["6505189c"],
	design: null,
	states: COMMENT_MIRROR_STATUSES,
	// An outbound comment is claimed before it is posted; a reply taken in from the room is
	// recorded delivered as it is written.
	initial: ["claimed", "delivered"],
	terminal: ["delivered", "refused"],
	reasonRequired: [],
	edges: [
		{
			from: "claimed",
			to: "claimed",
			act: "comment.mirrorReclaimed",
			permission: null,
			guards: [],
		},
		{
			from: "claimed",
			to: "delivered",
			act: "comment.mirrored",
			permission: null,
			guards: [],
		},
		{
			from: "claimed",
			to: "refused",
			act: "comment.mirrorRefused",
			permission: null,
			guards: [],
		},
	],
});

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
