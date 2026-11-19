// The one place a person gives a secret (ISS-1348, owner 2026-11-19): what an agent asked for comes
// first, each request filled in one step in a form fit for the value's shape, and every secret the
// project holds below it, grouped by what uses it. No value is ever answered here: a slot says
// whether it holds one, when and through whom, never what.

import { z } from "zod";

/** The shapes an asking agent names without spelling the fields out. */
export const SECRET_SHAPE_PRESETS = ["value", "file", "mailbox", "signin"] as const;
export type SecretShapePreset = (typeof SECRET_SHAPE_PRESETS)[number];

/** One labelled field of a structured value; the form writes them as one JSON object, by `key`. */
export const secretShapeFieldSchema = z.strictObject({
	key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/, "a JSON key: a letter, then letters, digits or _"),
	label: z.string().trim().min(1).max(40).describe("what a person reads above the box, in plain words"),
	secret: z.boolean().optional().describe("masked as a password is"),
	example: z.string().trim().min(1).max(80).optional().describe("a made-up example, never the value"),
});
export type SecretShapeField = z.infer<typeof secretShapeFieldSchema>;

export const secretShapeSchema = z.union([
	z.enum(SECRET_SHAPE_PRESETS),
	z.strictObject({ fields: z.array(secretShapeFieldSchema).min(2).max(12) }),
]);
export type SecretShape = z.infer<typeof secretShapeSchema>;

/** A mailbox a product reads and sends from: the JSON a mail service is given. */
export const MAILBOX_FIELDS: readonly SecretShapeField[] = [
	{ key: "username", label: "Address", example: "support@example.com" },
	{ key: "password", label: "Password", secret: true },
	{ key: "imapHost", label: "IMAP host", example: "imap.example.com" },
	{ key: "imapPort", label: "IMAP port", example: "993" },
	{ key: "smtpHost", label: "SMTP host", example: "smtp.example.com" },
	{ key: "smtpPort", label: "SMTP port", example: "465" },
];

/** An account a test signs in as (`project-config/actor-sign-in.ts` reads `username` and `password`). */
export const SIGNIN_FIELDS: readonly SecretShapeField[] = [
	{ key: "username", label: "Account", example: "tester@example.com" },
	{ key: "password", label: "Password", secret: true },
];

/** The form a shape is filled in: one masked box, a file, or labelled fields written as one JSON object. */
export type SecretForm = { kind: "value" } | { kind: "file" } | { kind: "fields"; fields: SecretShapeField[] };

export function secretFormOf(shape: SecretShape | null | undefined): SecretForm {
	if (shape === "file") return { kind: "file" };
	if (shape === "mailbox") return { kind: "fields", fields: [...MAILBOX_FIELDS] };
	if (shape === "signin") return { kind: "fields", fields: [...SIGNIN_FIELDS] };
	if (shape && typeof shape === "object") return { kind: "fields", fields: shape.fields };
	return { kind: "value" };
}

/** The slot a request or a row names, by the fields `support.secret_link` takes. */
export type SecretSlotRef =
	| { kind: "variable"; environment: string | null; key: string }
	| { kind: "testing"; profile: string; actor?: string; service?: string }
	| { kind: "integration"; provider: string };

/** Where the page writes a slot's value: through the slot's own door, which judges it. */
export type SecretSlotDoor =
	| { kind: "variable"; key: string; environment: string | null; variable: { id: string; version: number } | null }
	| { kind: "secret"; scope: string; name: string }
	| { kind: "connection"; connection: string; field: string };

/** That a slot holds a value: when, by whom (null where unknown), and through which door. */
export interface SecretHeld {
	at: string;
	by: string | null;
	via: "page" | "presigned" | null;
}

export interface SecretSlotView {
	/** The slot's place on the page (`#<anchor>`), stable for its slot. */
	anchor: string;
	/** The slot as an agent names it; null for a stored secret no testing profile names. */
	ref: SecretSlotRef | null;
	/** The slot in plain words, read off its key or name. */
	label: string;
	/** Its key, or its profile and name, or its provider: secondary text only. */
	detail: string;
	/** The environment it serves, where one; its tier, where the project declares one. */
	environment: string | null;
	tier: string | null;
	door: SecretSlotDoor;
	form: SecretForm;
	held: SecretHeld | null;
}

export interface SecretRequestView {
	/** The newest ask for this slot; `askIds` holds every ask a link may name for it. */
	id: string;
	askIds: string[];
	slot: SecretSlotView;
	/** The asking line: what the value is for, in the agent's words. */
	why: string;
	example: string | null;
	askedAt: string;
	/** The person the agent was answering in the thread, by the name the room shows; null where unknown. */
	askedFor: string | null;
	/** When this request was filled through the page or its command; null while it waits. */
	filled: SecretHeld | null;
}

export const SECRET_GROUP_KINDS = ["app", "testing", "connections", "other"] as const;
export type SecretGroupKind = (typeof SECRET_GROUP_KINDS)[number];

export interface SecretSlotGroup {
	/** The group's place on the page. */
	anchor: string;
	kind: SecretGroupKind;
	/** app: the environment (null for every one); testing: the profile, by its id. */
	name: string | null;
	/** testing: the environments that test with the profile. */
	usedIn: string[];
	tier: string | null;
	slots: SecretSlotView[];
}

export interface SecretSlotsRead {
	/** Requests waiting first, then the ones filled in the last week; newest first in each. */
	requests: SecretRequestView[];
	groups: SecretSlotGroup[];
	says: string;
}

/** A one-time write URL the page mints for a request, for a value that sits in a file. */
export interface SecretWriteMinted {
	url: string;
	method: "PUT";
	expiresAt: string;
	minutes: number;
	command: string;
}
