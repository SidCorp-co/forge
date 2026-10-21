// one declaration of the mockup vocabulary (ISS-78): core's table CHECKs, REST, MCP and the web
// import the kinds, statuses, limits, refusal codes, request schemas and views from here

import { z } from "zod";
import type { IssueStatusTone } from "./issue-vocabulary.js";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";

export const MOCKUP_KINDS = [
	"wireframe",
	"sketch",
	"image",
	"html",
	"api_example",
] as const;
export type MockupKind = (typeof MOCKUP_KINDS)[number];

export const MOCKUP_KIND_LABELS: Record<MockupKind, string> = {
	wireframe: "Wireframe",
	sketch: "Sketch",
	image: "Image",
	html: "HTML mockup",
	api_example: "API example",
};

export const MOCKUP_KIND_MIMES: Record<MockupKind, readonly string[]> = {
	wireframe: ["application/json"],
	sketch: ["image/png"],
	image: [
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"image/svg+xml",
	],
	html: ["text/html"],
	api_example: ["application/json", "text/plain"],
};

export const MOCKUP_STATUSES = [
	"proposed",
	"accepted",
	"returned",
	"withdrawn",
] as const;
export type MockupStatus = (typeof MOCKUP_STATUSES)[number];

export const MOCKUP_STATUS_LABELS: Record<MockupStatus, string> = {
	proposed: "Proposed",
	accepted: "Accepted",
	returned: "Returned",
	withdrawn: "Withdrawn",
};

export const MOCKUP_STATUS_TONES: Record<MockupStatus, IssueStatusTone> = {
	proposed: "you",
	accepted: "ready",
	returned: "done",
	withdrawn: "done",
};

export const MOCKUP_STATUS_GLYPHS: Record<MockupStatus, string> = {
	proposed: "!",
	accepted: "✓",
	returned: "↺",
	withdrawn: "–",
};

export const MOCKUP_STATUS_HINTS: Record<MockupStatus, string> = {
	proposed: "proposed: waits on a person to accept or return it",
	accepted: "accepted: a person accepted it",
	returned: "returned: a person sent it back with a reason",
	withdrawn: "withdrawn: its author took it back",
};

export const MOCKUP_TARGET_TYPES = [
	"requirement",
	"feedback",
	"issue",
] as const;
export type MockupTargetType = (typeof MOCKUP_TARGET_TYPES)[number];

export const MOCKUP_LIMITS = {
	bytes: {
		wireframe: 1024 * 1024,
		sketch: 5 * 1024 * 1024,
		image: 5 * 1024 * 1024,
		html: 1024 * 1024,
		api_example: 256 * 1024,
	} satisfies Record<MockupKind, number>,
	openPerTarget: 20,
	captionChars: 500,
	nameChars: 200,
	reasonChars: 2_000,
	commentChars: 4_000,
	commentsPerMockup: 200,
	answersPerRevision: 100,
} as const;

const MOCKUP_SOURCES = ["issue", "comment"] as const;

export const MOCKUP_REFUSAL_CODES = [
	"MOCKUP_CONTENT_REQUIRED",
	"MOCKUP_TYPE_INVALID",
	"MOCKUP_TOO_LARGE",
	"MOCKUP_SOURCE_OTHER_PROJECT",
	"MOCKUP_SOURCE_NOT_FOUND",
	"MOCKUP_TARGET_INVALID",
	"MOCKUP_QUEUE_FULL",
	"MOCKUP_DECIDED",
	...PERMISSION_REFUSAL_CODES,
	"MOCKUP_WITHDRAW_FORBIDDEN",
	"MOCKUP_REASON_REQUIRED",
	"MOCKUP_REVISION_SUPERSEDED",
	"MOCKUP_REVISES_INVALID",
	"MOCKUP_COMMENT_CLOSED",
	"MOCKUP_COMMENT_UNKNOWN",
	"MOCKUP_COMMENT_SETTLED",
	"MOCKUP_COMMENTS_FULL",
] as const;
export type MockupRefusalCode = (typeof MOCKUP_REFUSAL_CODES)[number];

/**
 * Exactly one target, as feedback names exactly one: a requirement at one of its revisions (the
 * current one or the open draft; left out, the open draft where there is one, else the current), a
 * feedback item or an issue (REQ-49).
 */
export const mockupTargetSchema = z.union([
	z.strictObject({
		requirement: z.string().trim().min(1).max(64),
		revision: z.number().int().min(1).optional(),
	}),
	z.strictObject({ feedback: z.string().trim().min(1).max(64) }),
	z.strictObject({ issue: z.string().trim().min(1).max(64) }),
]);
export type MockupTargetInput = z.infer<typeof mockupTargetSchema>;

const mockupSourceSchema = z.strictObject({
	from: z.enum(MOCKUP_SOURCES),
	attachmentId: z.uuid(),
});

/**
 * A point (`w`, `h` absent) or a region of a mockup's frame, each as a fraction of its width and
 * height, so it points at the same place whatever size the frame is drawn at (REQ-49 BC-2).
 */
export const mockupPinSchema = z
	.strictObject({
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		w: z.number().gt(0).max(1).optional(),
		h: z.number().gt(0).max(1).optional(),
	})
	.refine((p) => (p.w === undefined) === (p.h === undefined), {
		message: "a region names both w and h; a point names neither",
		path: ["w"],
	})
	.refine((p) => p.x + (p.w ?? 0) <= 1 + 1e-9 && p.y + (p.h ?? 0) <= 1 + 1e-9, {
		message: "a region stays inside the frame: x + w and y + h are at most 1",
		path: ["x"],
	});
export type MockupPin = z.infer<typeof mockupPinSchema>;

/** One comment a next revision settles: `answers` changed the mockup for it, `resolves` closes it with a note and no change. */
const settledCommentSchema = z.strictObject({
	comment: z.uuid(),
	note: z.string().trim().min(1).max(MOCKUP_LIMITS.commentChars).optional(),
});
const resolvedCommentSchema = z.strictObject({
	comment: z.uuid(),
	note: z.string().trim().min(1).max(MOCKUP_LIMITS.commentChars),
});

/**
 * `POST /api/projects/:id/mockups`: a proposal, as bytes, a wireframe document, or an upload already
 * in this project. `revises` makes it the next revision of a returned mockup (REQ-49 BC-3): it takes
 * that mockup's target unless one is named, and settles the comments it names.
 */
export const proposeMockupRequestSchema = z.strictObject({
	target: mockupTargetSchema.optional(),
	kind: z.enum(MOCKUP_KINDS),
	name: z.string().trim().min(1).max(MOCKUP_LIMITS.nameChars).optional(),
	mime: z.string().trim().min(3).max(200).optional(),
	caption: z.string().trim().max(MOCKUP_LIMITS.captionChars).optional(),
	contentBase64: z.string().min(4).optional(),
	document: z.unknown().optional(),
	source: mockupSourceSchema.optional(),
	revises: z.string().trim().min(1).max(64).optional(),
	answers: z
		.array(settledCommentSchema)
		.max(MOCKUP_LIMITS.answersPerRevision)
		.optional(),
	resolves: z
		.array(resolvedCommentSchema)
		.max(MOCKUP_LIMITS.answersPerRevision)
		.optional(),
});
export type ProposeMockupRequest = z.infer<typeof proposeMockupRequestSchema>;
export const PROPOSE_MOCKUP_SHAPE =
	"{ target: { requirement, revision? } | { feedback } | { issue } (optional with revises), kind: wireframe | sketch | image | html | api_example, caption?, exactly one of { name, mime?, contentBase64 }, { document } (a wireframe-v1 board) or { source: { from: issue | comment, attachmentId }, name? }, revises?: MK-n (a returned mockup this is the next revision of), answers?: [{ comment, note? }], resolves?: [{ comment, note }] }";

/** `POST …/mockups/:mk/comments`: what the person says, and where on the frame it points. */
export const commentMockupRequestSchema = z.strictObject({
	body: z.string().trim().min(1).max(MOCKUP_LIMITS.commentChars),
	pin: mockupPinSchema.optional(),
});
export type CommentMockupRequest = z.infer<typeof commentMockupRequestSchema>;
export const COMMENT_MOCKUP_SHAPE =
	"{ body, pin?: { x, y } (a point) | { x, y, w, h } (a region), each a fraction 0..1 of the frame }";

/** `POST …/mockups/:mk/accept | return`: return says why; accept may. */
export const decideMockupRequestSchema = z.strictObject({
	reason: z.string().trim().max(MOCKUP_LIMITS.reasonChars).optional(),
});
export const DECIDE_MOCKUP_SHAPE = "{ reason? } (return needs one)";

/** `GET /api/projects/:id/mockups?requirement=REQ-n | feedback=FB-n | issue=ISS-n`. */
export const listMockupsQuerySchema = z.strictObject({
	requirement: z.string().trim().min(1).max(64).optional(),
	feedback: z.string().trim().min(1).max(64).optional(),
	issue: z.string().trim().min(1).max(64).optional(),
});

export interface MockupTargetView {
	type: MockupTargetType;
	/** REQ-n, FB-n or ISS-n. */
	key: string;
	/** Requirement only: the revision it was proposed against. */
	revision: number | null;
}

/** The latest baseline that pins it, on a requirement mockup; null when none does yet. */
export interface MockupPinView {
	revision: number;
	seq: number;
}

/** How a comment was settled by a next revision: `answered` changed the mockup for it, `resolved` closed it with a note. */
export const MOCKUP_COMMENT_SETTLEMENTS = ["answered", "resolved"] as const;
export type MockupCommentSettlement =
	(typeof MOCKUP_COMMENT_SETTLEMENTS)[number];

/** One comment on a mockup, where it points, and the revision that settled it. */
export interface MockupCommentView {
	id: string;
	/** The mockup (MK-n) it was made on. */
	on: string;
	body: string;
	pin: MockupPin | null;
	authorId: string;
	authorName: string | null;
	authorAgency: "human" | "agent";
	createdAt: string;
	settled: {
		as: MockupCommentSettlement;
		/** The revision (MK-n) that settled it. */
		by: string;
		note: string | null;
		at: string;
	} | null;
}

export interface MockupCommentsResponse {
	/** Every comment on this mockup and on the revisions before it, oldest first. */
	comments: MockupCommentView[];
	open: number;
}

export interface MockupCommentResponse {
	comment: MockupCommentView;
}

/** One mockup as every door shows it; `url` serves its bytes to a person. */
export interface MockupView {
	id: string;
	key: string;
	target: MockupTargetView;
	kind: MockupKind;
	name: string;
	mime: string;
	size: number;
	caption: string | null;
	status: MockupStatus;
	proposedBy: string;
	proposedByName: string | null;
	proposedAgency: "human" | "agent";
	createdAt: string;
	decidedBy: string | null;
	decidedByName: string | null;
	decidedAt: string | null;
	reason: string | null;
	pinned: MockupPinView | null;
	/** 1 for a first proposal; n + 1 for the next revision of a returned one. */
	round: number;
	/** The mockup (MK-n) this one is the next revision of; null on a first proposal. */
	revises: string | null;
	/** The mockup (MK-n) proposed as this one's next revision; null while none is. */
	revisedBy: string | null;
	/** Comments made on this mockup: how many, and how many no revision has settled yet. */
	comments: { total: number; open: number };
	url: string;
	can: {
		accept: boolean;
		return: boolean;
		withdraw: boolean;
		/** Comment on it: it is proposed or returned, and no next revision was proposed yet. */
		comment: boolean;
		/** Propose its next revision: it is returned and has none yet. */
		revise: boolean;
	};
}

export interface MockupResponse {
	mockup: MockupView;
}

export interface MockupListResponse {
	mockups: MockupView[];
	returned: number;
	open: number;
}

export function mockupKindTakes(kind: MockupKind, mime: string): boolean {
	return MOCKUP_KIND_MIMES[kind].includes(mime);
}

export function mockupKindOfFile(name: string, mime: string): MockupKind {
	if (name.endsWith(".wireframe.json")) return "wireframe";
	if (MOCKUP_KIND_MIMES.image.includes(mime)) return "image";
	if (mime === "text/html" || /\.html?$/i.test(name)) return "html";
	return "api_example";
}
