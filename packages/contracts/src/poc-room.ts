// A POC room (REQ-44 "POC rooms: build live with the owner, deliver only what is settled"): a chat
// beside a live preview, built by a room agent on a POC branch of its own. The room is an idea preview
// (`./preview.ts`, REQ-41 BC-14..16) plus this record: who is in it, every ask with when it showed and
// the commit that showed it, and the items a person settled. Settling writes the settled items into a
// requirement (criteria and picture), merges the branch straight into the project's dev branch less
// what was not settled, and files a follow-up issue that verifies, reviews and cleans it afterwards.

import { z } from "zod";
import {
	keepPreviewRequestSchema,
	PREVIEW_IDEA_LIMITS,
	PREVIEW_LIMITS,
	previewRecordSchema,
	SKETCH_BRANCH,
} from "./preview.js";
import type { RefusalStatuses } from "./refusal.js";
import { defineMachine, fromEach } from "./state-machine.js";

/**
 * `open`: the room agent builds on asks. `settling`: a person settled it; the agent takes out what
 * was not settled, then the box merges the branch into the dev branch. `settled`: merged, the
 * requirement written and the follow-up issue filed. `abandoned`: its branch and preview removed,
 * its chat kept readable.
 */
export const ROOM_STATES = ["open", "settling", "settled", "abandoned"] as const;
export type RoomState = (typeof ROOM_STATES)[number];

/** The room's moves; registered in `./machines.ts` with its table `poc_rooms`. */
export const ROOM_MACHINE = defineMachine({
	entity: "room",
	shapes: ["f78b45ae"],
	design: null,
	states: ROOM_STATES,
	initial: ["open"],
	terminal: ["settled", "abandoned"],
	reasonRequired: ["abandoned"],
	edges: [
		{
			from: "open",
			to: "settling",
			act: "room.settleAsked",
			permission: "project.write",
			guards: [],
		},
		{
			from: "settling",
			to: "settled",
			act: "room.settled",
			permission: null,
			guards: [],
		},
		{
			from: "settling",
			to: "open",
			act: "room.settleFailed",
			permission: null,
			guards: [],
		},
		...fromEach<RoomState>(["open", "settling"], "abandoned", {
			act: "room.abandoned",
			permission: "project.write",
			guards: [],
		}),
	],
});

export const ROOM_LIMITS = {
	/** What a person asks the room agent, as a preview message takes it. */
	ask: PREVIEW_LIMITS.message,
	/** A settled item's words, as it becomes a criterion. */
	item: 400,
	/** The agent's reply kept on a turn. */
	reply: 4000,
	/** Turns a room keeps. */
	turns: 500,
} as const;

const ITEM_KEY = z
	.string()
	.regex(/^(REQ|FB)-\d{1,9}$/, "a requirement or feedback key such as REQ-44 or FB-12");

/** `POST /api/projects/:id/rooms`: open a room about a requirement or a feedback item, with the first ask. */
export const openRoomRequestSchema = z.strictObject({
	about: ITEM_KEY,
	brief: z.string().trim().min(1).max(PREVIEW_IDEA_LIMITS.brief),
});
export type OpenRoomRequest = z.infer<typeof openRoomRequestSchema>;

export const roomAskRequestSchema = z.strictObject({
	text: z.string().trim().min(1).max(ROOM_LIMITS.ask),
});

/** `POST /api/rooms/:id/items`: settle what a turn showed; `text` left out is the ask's own words. */
export const settleItemRequestSchema = z.strictObject({
	turnId: z.uuid(),
	text: z.string().trim().min(1).max(ROOM_LIMITS.item).optional(),
});

/** `POST /api/rooms/:id/settle`: the page the person sees, as the keep takes it, becomes the picture. */
export const settleRoomRequestSchema = keepPreviewRequestSchema;
export type SettleRoomRequest = z.infer<typeof settleRoomRequestSchema>;

export const abandonRoomRequestSchema = z.strictObject({
	reason: z.string().trim().min(1).max(PREVIEW_LIMITS.detail).optional(),
});

const person = z.strictObject({ userId: z.uuid(), name: z.string() });

/** One ask and what came of it: when the preview showed it (the agent's turn ended) and the commit it showed. */
export const roomTurnSchema = z.strictObject({
	id: z.uuid(),
	seq: z.int().min(1),
	/** Null for the agent's own turn (the trim before a settle). */
	by: person.nullable(),
	ask: z.string(),
	askedAt: z.iso.datetime(),
	reply: z.string().nullable(),
	shownAt: z.iso.datetime().nullable(),
	/** From the ask to the preview showing it, in milliseconds (BC-4). */
	shownAfterMs: z.int().min(0).nullable(),
	/** The branch head committed when the turn ended: the commit that showed it (BC-6). */
	commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
	/** Files the branch changed against its base at that commit. */
	files: z.array(z.string()).nullable(),
	kind: z.enum(["ask", "trim"]),
});
export type RoomTurn = z.infer<typeof roomTurnSchema>;

export const roomItemSchema = z.strictObject({
	id: z.uuid(),
	turnId: z.uuid(),
	commit: z.string().regex(/^[0-9a-f]{40}$/),
	text: z.string(),
	settledBy: person,
	settledAt: z.iso.datetime(),
});
export type RoomItem = z.infer<typeof roomItemSchema>;

export const roomSettleSchema = z.strictObject({
	/** The project's dev branch the POC branch merges into. */
	into: z.string(),
	askedBy: person,
	askedAt: z.iso.datetime(),
	mergeSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
	requirement: z.string().nullable(),
	revision: z.int().positive().nullable(),
	/** The follow-up issue: verify, review and code standards after the merge. */
	issue: z.strictObject({ id: z.uuid(), displayId: z.string().nullable() }).nullable(),
	/** What a step refused after the merge, by its own code; the merge itself stands. */
	refusals: z.array(z.strictObject({ code: z.string(), detail: z.string() })),
});
export type RoomSettle = z.infer<typeof roomSettleSchema>;

/** The room as every member reads it. */
export const roomSchema = z.strictObject({
	id: z.uuid(),
	projectId: z.uuid(),
	about: z.strictObject({
		kind: z.enum(["requirement", "feedback"]),
		key: ITEM_KEY,
		title: z.string(),
	}),
	branch: z.string().regex(SKETCH_BRANCH),
	state: z.enum(ROOM_STATES),
	/** Why it went back to open after a settle, or why it was abandoned. */
	detail: z.string().nullable(),
	/** Where its preview's data comes from: the project's demo data (throwaway), or its dev environment. */
	data: z.enum(["demo", "environment"]),
	createdBy: person,
	createdAt: z.iso.datetime(),
	preview: previewRecordSchema,
	members: z.array(person.extend({ joinedAt: z.iso.datetime() })),
	turns: z.array(roomTurnSchema),
	items: z.array(roomItemSchema),
	settle: roomSettleSchema.nullable(),
	/** Whether the reader may ask, settle and abandon (project.write). */
	canWrite: z.boolean(),
});
export type Room = z.infer<typeof roomSchema>;

export const roomEnvelopeSchema = z.strictObject({ room: roomSchema });

export const roomSummarySchema = z.strictObject({
	id: z.uuid(),
	about: z.string(),
	state: z.enum(ROOM_STATES),
	members: z.int().min(0),
	createdAt: z.iso.datetime(),
});
export const roomListSchema = z.strictObject({ rooms: z.array(roomSummarySchema) });

export const ROOM_REFUSAL_CODES = [
	"ROOM_NOT_FOUND",
	"ROOM_FORBIDDEN",
	/** Settled, abandoned or settling: the act needs an open room. */
	"ROOM_CLOSED",
	/** An item is settled from a turn the preview showed, which has its commit. */
	"ROOM_TURN_NOT_SHOWN",
	"ROOM_NOTHING_SETTLED",
	/** The preview sleeps or failed; joining wakes it, and a settle needs it awake. */
	"ROOM_ASLEEP",
	/** The project declares no git source with a default branch, so there is no dev branch to merge into. */
	"ROOM_NO_DEV_BRANCH",
	/** The dev branch is main or the branch production deploys from: a POC never merges there directly. */
	"ROOM_PRODUCTION_BRANCH",
	/** The requirement is not a screen, which is what a room's picture draws. */
	"ROOM_NOT_A_SCREEN",
	/** The box was asked to merge the room and has not reported: the room settles or reopens on its report. */
	"ROOM_MERGE_PENDING",
] as const;
export type RoomRefusalCode = (typeof ROOM_REFUSAL_CODES)[number];

export const ROOM_REFUSAL_STATUSES = {
	ROOM_NOT_FOUND: 404,
	ROOM_FORBIDDEN: 403,
	ROOM_CLOSED: 409,
	ROOM_TURN_NOT_SHOWN: 409,
	ROOM_NOTHING_SETTLED: 409,
	ROOM_ASLEEP: 409,
	ROOM_MERGE_PENDING: 409,
} as const satisfies RefusalStatuses<RoomRefusalCode>;

/** Branches a POC never merges into whatever the project declares (REQ-44 scope out). */
export const ROOM_NEVER_MERGES_INTO = ["main", "master"] as const;

export const ROOM_ROUTES = {
	/** POST: open a room. GET: the project's rooms. */
	ofProject: "/api/projects/:id/rooms",
	get: "/api/rooms/:id",
	join: "/api/rooms/:id/join",
	asks: "/api/rooms/:id/asks",
	items: "/api/rooms/:id/items",
	item: "/api/rooms/:id/items/:itemId",
	settle: "/api/rooms/:id/settle",
	abandon: "/api/rooms/:id/abandon",
} as const;
