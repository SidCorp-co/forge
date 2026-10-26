// A project's Rocket.Chat group answered by one Claude session Forge manages (REQ-75 r2). The
// group's members are never Forge users: the session acts as the room's own agent account, reads
// the project's knowledge and published OpenAPI, runs the checks the project grants, proposes the
// fixes it grants and runs one only after the person who asked confirms in chat, and records what
// needs code as Feedback it then follows in the same thread until it ships.
//
// Two integrations carry the configuration, both policy (VISION kernel-hard-policy-soft): a
// `rocketchat` binding with a `support` block names the one group and its limits; a `support-api`
// connection holds the product API's base URL, the hosts it grants and the scoped credential, and
// its binding declares the tools. The refusals below are the kernel.

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";

/** The limits a support group runs under unless its binding names its own. */
export const SUPPORT_LIMIT_DEFAULTS = {
	/** Messages one account may have answered in an hour; past it, one notice and silence. */
	messagesPerUserPerHour: 30,
	/** Fixes one account may confirm in a day. */
	fixesPerUserPerDay: 10,
	/** Longest message handed to the session; a longer one is cut and says so. */
	messageMaxChars: 4000,
	/** Bytes of a tool's answer handed back to the session. */
	responseMaxBytes: 16_000,
} as const;

export const supportLimitsSchema = z.strictObject({
	messagesPerUserPerHour: z.number().int().min(1).max(1000).optional(),
	fixesPerUserPerDay: z.number().int().min(0).max(1000).optional(),
	messageMaxChars: z.number().int().min(200).max(8000).optional(),
	responseMaxBytes: z.number().int().min(1000).max(200_000).optional(),
});
export type SupportLimits = z.infer<typeof supportLimitsSchema>;

/**
 * The `support` block of a `rocketchat` binding: present, the binding's one room is a support group
 * answered by the session; absent, the room is the team assistant's, as before.
 */
export const supportRoomConfigSchema = z.strictObject({
	/** What the product is, in a sentence or two, for the session's brief. */
	product: z.string().trim().min(3).max(600).optional(),
	limits: supportLimitsSchema.optional(),
});
export type SupportRoomConfig = z.infer<typeof supportRoomConfigSchema>;

/** A tool's kind: `diagnose` reads (GET or HEAD only) and runs at once; `fix` waits on the asker. */
export const SUPPORT_TOOL_KINDS = ["diagnose", "fix"] as const;
export type SupportToolKind = (typeof SUPPORT_TOOL_KINDS)[number];

export const SUPPORT_TOOL_METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
] as const;
export const SUPPORT_READ_METHODS = ["GET", "HEAD"] as const;

const paramName = z
	.string()
	.regex(
		/^[A-Za-z][A-Za-z0-9_]{0,47}$/,
		"a parameter name: a letter, then letters, digits or _",
	);

export const supportToolParamSchema = z.strictObject({
	in: z.enum(["path", "query", "body"]),
	description: z.string().trim().min(3).max(300),
	required: z.boolean().optional(),
	/** A regular expression the value must match whole, checked before the call. */
	pattern: z.string().min(1).max(200).optional(),
});

export const supportToolSchema = z
	.strictObject({
		name: z
			.string()
			.regex(/^[a-z][a-z0-9_]{1,47}$/, "a tool name: lower case, digits and _"),
		kind: z.enum(SUPPORT_TOOL_KINDS),
		method: z.enum(SUPPORT_TOOL_METHODS),
		/** Under the connection's base URL, `{param}` for a path parameter: `/orders/{orderId}`. */
		path: z
			.string()
			.max(300)
			.regex(
				/^\/[^\s?#]*$/,
				"a path under the base URL, starting with /, no query",
			),
		/** What it does, in words the asker reads in the confirm prompt and the check line. */
		summary: z.string().trim().min(3).max(300),
		params: z.record(paramName, supportToolParamSchema).optional(),
	})
	.superRefine((tool, ctx) => {
		if (
			tool.kind === "diagnose" &&
			!(SUPPORT_READ_METHODS as readonly string[]).includes(tool.method)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["method"],
				message: `a diagnose tool only reads: its method is GET or HEAD, and ${tool.name} declares ${tool.method}`,
			});
		}
		const placeholders = [...tool.path.matchAll(/\{([^}]+)\}/g)].map(
			(m) => m[1],
		);
		for (const p of placeholders) {
			if (tool.params?.[p as string]?.in !== "path") {
				ctx.addIssue({
					code: "custom",
					path: ["params"],
					message: `the path names {${p}}, and params declares no path parameter ${p}`,
				});
			}
		}
		for (const [name, p] of Object.entries(tool.params ?? {})) {
			if (p.in === "path" && !placeholders.includes(name)) {
				ctx.addIssue({
					code: "custom",
					path: ["params", name],
					message: `${name} is a path parameter, and the path names no {${name}}`,
				});
			}
			if (p.pattern) {
				try {
					new RegExp(p.pattern);
				} catch {
					ctx.addIssue({
						code: "custom",
						path: ["params", name, "pattern"],
						message: "not a regular expression",
					});
				}
			}
		}
		if (
			tool.kind === "diagnose" &&
			Object.values(tool.params ?? {}).some((p) => p.in === "body")
		) {
			ctx.addIssue({
				code: "custom",
				path: ["params"],
				message: "a diagnose tool reads, so it takes no body parameter",
			});
		}
	});
export type SupportTool = z.infer<typeof supportToolSchema>;

/** An exact host name the project grants, lower case, no scheme, no path. */
export const supportHostSchema = z
	.string()
	.max(253)
	.regex(
		/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/,
		"a host name, lower case, optionally with :port",
	);

/** The `support-api` connection's config: where the product API is and what else it may reach. */
export const supportApiConnectionConfigSchema = z.strictObject({
	baseUrl: z
		.url()
		.max(500)
		.regex(/^https?:\/\//, "an http(s) URL"),
	/** Hosts granted beside the base URL's own. Nothing else is ever called. */
	hosts: z.array(supportHostSchema).max(20).optional(),
});
export type SupportApiConnectionConfig = z.infer<
	typeof supportApiConnectionConfigSchema
>;

/** The scoped credential, sealed in the vault: header name → value, sent on every call. */
export const supportApiSecretsSchema = z.strictObject({
	headers: z
		.record(
			z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "a header name"),
			z.string().min(1).max(4000),
		)
		.refine((h) => Object.keys(h).length <= 10, "at most 10 headers"),
});

/** The `support-api` binding's config: the tools this project grants its support session. */
export const supportApiBindingConfigSchema = z.strictObject({
	tools: z
		.array(supportToolSchema)
		.min(1)
		.max(40)
		.refine(
			(tools) => new Set(tools.map((t) => t.name)).size === tools.length,
			"two tools share a name; a name names one tool",
		),
});
export type SupportApiBindingConfig = z.infer<
	typeof supportApiBindingConfigSchema
>;

/**
 * What one support action was. `message_in` an inbound message (undelivered until a turn took it),
 * `reply` a line the session posted, `diagnose` a check that ran, `fix_*` a fix's life,
 * `feedback_recorded` an item filed, `progress_posted` a progress line, `refused` a refusal the
 * room was told of.
 */
export const SUPPORT_ACTION_KINDS = [
	"message_in",
	"reply",
	"diagnose",
	"fix_proposed",
	"fix_confirmed",
	"fix_ran",
	"fix_failed",
	"fix_declined",
	"fix_expired",
	"feedback_recorded",
	"progress_posted",
	"refused",
] as const;
export type SupportActionKind = (typeof SUPPORT_ACTION_KINDS)[number];

/** Who took an action: a group member (by their Rocket.Chat account), the session, or core itself. */
export const SUPPORT_ACTOR_KINDS = ["member", "session", "core"] as const;
export type SupportActorKind = (typeof SUPPORT_ACTOR_KINDS)[number];

/** pending: waits on the asker. ran / failed: confirmed and called. declined / expired: never called. */
export const SUPPORT_FIX_STATES = [
	"pending",
	"ran",
	"failed",
	"declined",
	"expired",
] as const;
export type SupportFixState = (typeof SUPPORT_FIX_STATES)[number];

/** How long a proposed fix waits for its asker. */
export const SUPPORT_FIX_TTL_MS = 15 * 60_000;

/** A fix's code: what the asker types after `confirm`. Unambiguous letters and digits. */
export const SUPPORT_CONFIRM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
/** A message that confirms or declines a fix: the word, then the code, and nothing else. */
export const SUPPORT_CONFIRM_MESSAGE_PATTERN =
	/^\s*(confirm|cancel)\s+([A-HJ-NP-Z2-9]{6})\s*$/i;

/** What the session records an item as: the kinds a group member's need maps to. */
export const SUPPORT_RECORD_KINDS = ["defect", "feature", "request"] as const;
export type SupportRecordKind = (typeof SUPPORT_RECORD_KINDS)[number];

const threadId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
	.describe(
		"the thread: the id the message you answer carries as `thread` in what you were handed",
	);

export const SUPPORT_ACTIONS = [
	"search",
	"thread",
	"tools",
	"reply",
	"run",
	"propose_fix",
	"record",
] as const;
export type SupportAction = (typeof SUPPORT_ACTIONS)[number];

export const supportSearchRequestSchema = z.strictObject({
	query: z.string().trim().min(2).max(300),
});
export const supportThreadRequestSchema = z.strictObject({ thread: threadId });
export const supportReplyRequestSchema = z.strictObject({
	thread: threadId,
	text: z.string().trim().min(1).max(4000),
});
export const supportRunRequestSchema = z.strictObject({
	thread: threadId,
	tool: z.string().min(1).max(48),
	args: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional(),
});
export const supportProposeFixRequestSchema = z.strictObject({
	thread: threadId,
	tool: z.string().min(1).max(48),
	args: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional(),
	/** The Rocket.Chat account id of the person who asked, as you were handed it (`from.id`). */
	asker: z.string().min(1).max(64),
});
export const supportRecordRequestSchema = z.strictObject({
	thread: threadId,
	kind: z.enum(SUPPORT_RECORD_KINDS),
	title: z.string().trim().min(3).max(200),
	/** What the person needs, said plainly: what they did, saw and expected, or what they ask for. */
	summary: z.string().trim().min(3).max(4000),
	whereSeen: z.string().trim().min(1).max(300).optional(),
});

/** One action as Forge shows it. Inputs and outputs are stored scrubbed. */
export interface SupportActionView {
	id: string;
	kind: SupportActionKind;
	thread: string;
	conversationId: string | null;
	actor: {
		kind: SupportActorKind;
		account: string | null;
		label: string | null;
	};
	tool: string | null;
	input: unknown;
	output: unknown;
	feedbackKey: string | null;
	at: string;
}

/** One support group as Forge shows it. */
export interface SupportRoomView {
	id: string;
	projectId: string;
	bindingId: string;
	rid: string;
	sessionId: string | null;
	sessionStatus: string | null;
	principalUserId: string;
	toolCount: number;
	threads: number;
	createdAt: string;
}

export const SUPPORT_REFUSAL_CODES = [
	"SUPPORT_REFUSED",
	"SUPPORT_ROOM_UNKNOWN",
	"SUPPORT_NOT_THE_ROOM_SESSION",
	"SUPPORT_THREAD_UNKNOWN",
	"SUPPORT_ASKER_NOT_IN_THREAD",
	"SUPPORT_TOOL_UNDECLARED",
	"SUPPORT_TOOL_KIND",
	"SUPPORT_TOOL_ARGS",
	"SUPPORT_HOST_NOT_GRANTED",
	"SUPPORT_TOOLS_UNBOUND",
	"SUPPORT_REPLY_REFUSED",
	"SUPPORT_LIMIT_REACHED",
] as const;
export type SupportRefusalCode = (typeof SUPPORT_REFUSAL_CODES)[number];

/** The codes the call door itself refuses with, before any byte is sent. */
export type SupportCallRefusalCode = Extract<
	SupportRefusalCode,
	| "SUPPORT_TOOL_UNDECLARED"
	| "SUPPORT_TOOL_KIND"
	| "SUPPORT_TOOL_ARGS"
	| "SUPPORT_HOST_NOT_GRANTED"
>;

export interface SupportRefusal {
	code: SupportRefusalCode;
	path: string;
	detail: string;
}

export const SUPPORT_REFUSAL_STATUSES = {
	SUPPORT_ROOM_UNKNOWN: 404,
	SUPPORT_NOT_THE_ROOM_SESSION: 403,
	SUPPORT_THREAD_UNKNOWN: 404,
	SUPPORT_ASKER_NOT_IN_THREAD: 409,
	SUPPORT_TOOL_UNDECLARED: 404,
	SUPPORT_TOOL_KIND: 409,
	SUPPORT_HOST_NOT_GRANTED: 403,
	SUPPORT_TOOLS_UNBOUND: 409,
	SUPPORT_LIMIT_REACHED: 409,
} as const satisfies RefusalStatuses<SupportRefusalCode>;
