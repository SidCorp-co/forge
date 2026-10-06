// one declaration of the mockup vocabulary (ISS-78): core's table CHECKs, REST, MCP and the web
// import the kinds, statuses, limits, refusal codes, request schemas and views from here

import { z } from "zod";
import type { IssueStatusTone } from "./issue-vocabulary.js";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";
import type { RefusalStatuses } from "./refusal.js";

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
	accepted:
		"accepted: pinned beside the designs at the next agree or re-pin of its requirement",
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
} as const;

const MOCKUP_SOURCES = ["issue", "comment"] as const;

export const MOCKUP_REFUSAL_CODES = [
	"MOCKUP_CONTENT_REQUIRED",
	"MOCKUP_TYPE_INVALID",
	"MOCKUP_TOO_LARGE",
	"MOCKUP_SOURCE_OTHER_PROJECT",
	"MOCKUP_SOURCE_NOT_FOUND",
	"MOCKUP_TARGET_INVALID",
	"MOCKUP_REVISION_SUPERSEDED",
	"MOCKUP_QUEUE_FULL",
	"MOCKUP_DECIDED",
	...PERMISSION_REFUSAL_CODES,
	"MOCKUP_WITHDRAW_FORBIDDEN",
	"MOCKUP_REASON_REQUIRED",
] as const;
export type MockupRefusalCode = (typeof MOCKUP_REFUSAL_CODES)[number];
export const MOCKUP_REFUSAL_STATUSES = {
	MOCKUP_REVISION_SUPERSEDED: 409,
} as const satisfies RefusalStatuses<MockupRefusalCode>;

/** Exactly one target, as feedback names exactly one: a requirement at one revision, a feedback item, or an issue. */
export const mockupTargetSchema = z.union([
	z.strictObject({
		requirement: z.string().trim().min(1).max(64),
		revision: z.number().int().min(1),
	}),
	z.strictObject({ feedback: z.string().trim().min(1).max(64) }),
	z.strictObject({ issue: z.string().trim().min(1).max(64) }),
]);
export type MockupTargetInput = z.infer<typeof mockupTargetSchema>;

const mockupSourceSchema = z.strictObject({
	from: z.enum(MOCKUP_SOURCES),
	attachmentId: z.uuid(),
});

/** `POST /api/projects/:id/mockups`: a proposal, as bytes, a wireframe document, or an upload already in this project. */
export const proposeMockupRequestSchema = z.strictObject({
	target: mockupTargetSchema,
	kind: z.enum(MOCKUP_KINDS),
	name: z.string().trim().min(1).max(MOCKUP_LIMITS.nameChars).optional(),
	mime: z.string().trim().min(3).max(200).optional(),
	caption: z.string().trim().max(MOCKUP_LIMITS.captionChars).optional(),
	contentBase64: z.string().min(4).optional(),
	document: z.unknown().optional(),
	source: mockupSourceSchema.optional(),
});
export type ProposeMockupRequest = z.infer<typeof proposeMockupRequestSchema>;
export const PROPOSE_MOCKUP_SHAPE =
	"{ target: { requirement, revision } | { feedback } | { issue }, kind: wireframe | sketch | image | html | api_example, caption?, and exactly one of { name, mime?, contentBase64 }, { document } (a wireframe-v1 board) or { source: { from: issue | comment, attachmentId }, name? } }";

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
	url: string;
	can: { accept: boolean; return: boolean; withdraw: boolean };
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
