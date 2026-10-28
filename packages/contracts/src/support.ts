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
import { ISSUE_STATUSES } from "./issue-machine.js";
import { REASON_PARAGRAPH_MAX } from "./reason-text.js";
import type { RefusalStatuses } from "./refusal.js";
import type { OperationsScope, SupportRoomKind } from "./support-operations.js";

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
 * What a room's binding may grant its session (REQ-75 r5 BC-27). `read_checkout` shows the session
 * the project's checkout read-only (without it the box shows an empty folder); `file_items` records
 * what needs code as Feedback; `deliver` moves an issue of the project as the member who asked;
 * `build` gives the session a writable working copy of the project's development branch, and once a
 * confirmer confirms, the box commits it on a feat/ or fix/ branch, pushes it (never forced) and core
 * opens a change request into the development branch, never the production one; `deploy` deploys a bound target the grant names; `run_commands` runs a command on a host the grant
 * names. Policy (VISION kernel-hard-policy-soft); the gate that refuses an ungranted one is core's.
 */
export const SUPPORT_ABILITIES = [
	"read_checkout",
	"file_items",
	"deliver",
	"build",
	"deploy",
	"run_commands",
] as const;
export type SupportAbility = (typeof SUPPORT_ABILITIES)[number];

/** Each ability in the words a refusal, the brief and the settings screen use. */
export const SUPPORT_ABILITY_MEANING: Record<SupportAbility, string> = {
	read_checkout: "read the project's checkout, read-only",
	file_items: "record what needs code as Feedback, once the asker confirms",
	deliver: "move an issue of this project, as the member who asked",
	build:
		"change code in a working copy of the development branch, then commit, push and open a change request into it once a confirmer confirms",
	deploy: "deploy a bound target this room names, once a confirmer confirms",
	run_commands:
		"run commands on the hosts this room names; a change waits for a confirmer",
};

/** Who reads a room: a product's users (no developer detail), or the team the room was bound for. */
export const SUPPORT_READERS = ["users", "team"] as const;
export type SupportReaders = (typeof SUPPORT_READERS)[number];

/** Which messages reach the session: every one, or only those that mention the bot. */
export const SUPPORT_ANSWERS = ["every-message", "mentions"] as const;
export type SupportAnswers = (typeof SUPPORT_ANSWERS)[number];

/** A host a room may run commands on: a name this box's SSH resolves, never an option. */
export const supportCommandHostSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/,
		"a host name as the box's SSH names it: letters, digits, . _ -",
	);

/** A Rocket.Chat username, as the server signs a message with it. */
export const chatUsernameSchema = z
	.string()
	.regex(/^[A-Za-z0-9._-]{1,64}$/, "a Rocket.Chat username, without @");

/**
 * A room's grant (BC-27): the abilities, and what the targeted ones reach. `deploy` names the
 * project's deploy bindings it may deploy, `run_commands` the hosts, and either names who may
 * confirm a change. Absent, a room holds no ability.
 */
export const supportGrantsSchema = z
	.strictObject({
		abilities: z
			.array(z.enum(SUPPORT_ABILITIES))
			.max(SUPPORT_ABILITIES.length)
			.refine((a) => new Set(a).size === a.length, "an ability is named once"),
		/** The project's deploy bindings (their ids) this room may deploy. */
		deployTargets: z.array(z.uuid()).max(20).optional(),
		hosts: z.array(supportCommandHostSchema).max(20).optional(),
		/** Whose `confirm <code>` lets a deploy or a host change run: Rocket.Chat usernames. */
		confirmers: z.array(chatUsernameSchema).max(20).optional(),
	})
	.superRefine((g, ctx) => {
		const has = (a: SupportAbility) => g.abilities.includes(a);
		if (has("deploy") !== Boolean(g.deployTargets?.length)) {
			ctx.addIssue({
				code: "custom",
				path: ["deployTargets"],
				message: has("deploy")
					? "deploy is granted and names no deploy target: name the bindings this room may deploy"
					: "deployTargets are named and deploy is not granted: grant deploy or drop them",
			});
		}
		if (has("run_commands") !== Boolean(g.hosts?.length)) {
			ctx.addIssue({
				code: "custom",
				path: ["hosts"],
				message: has("run_commands")
					? "run_commands is granted and names no host: name the hosts this room may run commands on"
					: "hosts are named and run_commands is not granted: grant run_commands or drop them",
			});
		}
		if (
			(has("deploy") || has("run_commands") || has("build")) &&
			!g.confirmers?.length
		) {
			ctx.addIssue({
				code: "custom",
				path: ["confirmers"],
				message:
					"build, deploy and run_commands change things outside Forge, so they wait for a confirmer: name at least one Rocket.Chat username",
			});
		}
	});
export type SupportGrants = z.infer<typeof supportGrantsSchema>;

/**
 * The `support` block of a `rocketchat` binding: present, the binding's one room is a support group
 * answered by the session; absent, the room is the team assistant's, as before.
 */
export const supportRoomConfigSchema = z.strictObject({
	/** What the product is, in a sentence or two, for the session's brief. */
	product: z.string().trim().min(3).max(600).optional(),
	/** Who the assistant is in this room and the rules it keeps, in the owner's words: the brief's first lines. */
	persona: z.string().trim().min(20).max(4000).optional(),
	/** Who reads the room; `users` when absent. A team room's replies may carry developer detail. */
	readers: z.enum(SUPPORT_READERS).optional(),
	/** Which messages reach the session; `every-message` when absent. */
	answers: z.enum(SUPPORT_ANSWERS).optional(),
	grants: supportGrantsSchema.optional(),
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
 * room was told of, `operation` an operations room's act (its action in `tool`).
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
	"operation",
] as const;
export type SupportActionKind = (typeof SUPPORT_ACTION_KINDS)[number];

/** Who took an action: a group member (by their Rocket.Chat account), the session, or core itself. */
export const SUPPORT_ACTOR_KINDS = ["member", "session", "core"] as const;
export type SupportActorKind = (typeof SUPPORT_ACTOR_KINDS)[number];

/**
 * What waits on a confirm: a granted `fix`, or a `filing` of what needs code as Feedback, each on
 * its asker's; a `deploy` of a bound target, or a `command` that changes a host, each on a confirmer
 * the room's grant names (REQ-75 r5 BC-27). All share one code space per room, so one
 * `confirm <code>` names one of them.
 */
export const SUPPORT_PROPOSAL_KINDS = [
	"fix",
	"filing",
	"deploy",
	"command",
	"build",
] as const;
export type SupportProposalKind = (typeof SUPPORT_PROPOSAL_KINDS)[number];

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
	"move_issue",
	"build",
	"deploy",
	"command",
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
	/** The member who confirms the filing: their account id; the thread's first writer when omitted. */
	asker: z.string().min(1).max(64).optional(),
});

export const supportMoveIssueRequestSchema = z.strictObject({
	thread: threadId,
	issue: z
		.string()
		.trim()
		.regex(/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/, "an issue key, PREFIX-n")
		.describe("an issue of this room's project, e.g. ISS-12"),
	to: z.enum(ISSUE_STATUSES).describe("the status to move it to"),
	reason: z.string().trim().min(1).max(REASON_PARAGRAPH_MAX).optional(),
});
/** A branch a room's build pushes: feat/ or fix/, then a slug. */
export const supportBuildBranchSchema = z
	.string()
	.regex(
		/^(feat|fix)\/[a-z0-9][a-z0-9._-]{1,60}$/,
		"a branch feat/<slug> or fix/<slug>, lower case",
	);
export const supportBuildRequestSchema = z.strictObject({
	thread: threadId,
	branch: supportBuildBranchSchema,
	/** The commit message's first line, and the change request's title. */
	title: z.string().trim().min(3).max(120),
	/** What changed and why, for the commit body and the change request. */
	summary: z.string().trim().min(3).max(4000),
});
export const supportDeployRequestSchema = z.strictObject({
	thread: threadId,
	/** A deploy binding this room's grant names, by its id as `tools` lists it. */
	target: z.uuid(),
});
/** The longest command a room may run on a host. */
export const SUPPORT_COMMAND_MAX_CHARS = 1000;
export const supportCommandRequestSchema = z.strictObject({
	thread: threadId,
	host: supportCommandHostSchema,
	command: z.string().trim().min(1).max(SUPPORT_COMMAND_MAX_CHARS),
});

/** What a box answers for one command it ran on a host, over its own SSH. */
export interface SupportCommandResult {
	host: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	durationMs: number;
}

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

/**
 * How a member's message reached the session: as the first message of a cold turn (`start`), of a
 * turn that resumed the resident session (`send`), or written into a turn already running
 * (`inject`).
 */
export const SUPPORT_DELIVERY_PATHS = ["start", "send", "inject"] as const;
export type SupportDeliveryPath = (typeof SUPPORT_DELIVERY_PATHS)[number];

/**
 * How fast a room answers (REQ-75 BC-11): from a member message's Rocket.Chat timestamp to the
 * session's first post in its thread, over the room's last `SUPPORT_LATENCY_WINDOW` answered
 * messages, overall and by how each reached the session.
 */
export interface SupportLatencyView {
	measured: number;
	p50Ms: number | null;
	p95Ms: number | null;
	byPath: Record<
		SupportDeliveryPath,
		{ measured: number; p50Ms: number | null; p95Ms: number | null }
	>;
}

/** The answered messages a room's latency is read over. */
export const SUPPORT_LATENCY_WINDOW = 200;

/**
 * Why a room is not answering (REQ-75 r5 BC-26), each a cause somebody can act on: the binding is
 * off; the chat server refuses the bot or does not answer; the bot is not a member of the group; no
 * core process holds the bot's live connection; no online box of the project can run the session,
 * or it lacks what the room's grants need; the session is not resident on its box.
 */
export const SUPPORT_HEALTH_CAUSES = [
	"BINDING_OFF",
	"BOT_REJECTED",
	"CHAT_UNREACHABLE",
	"BOT_NOT_IN_ROOM",
	"NOT_LISTENING",
	"NO_BOX",
	"BOX_TOO_OLD",
	"SESSION_NOT_LISTENING",
] as const;
export type SupportHealthCause = (typeof SUPPORT_HEALTH_CAUSES)[number];

export interface SupportRoomHealth {
	/** True exactly when `causes` is empty. */
	healthy: boolean;
	causes: { code: SupportHealthCause; detail: string }[];
	checkedAt: string;
}

/** The box capability a room's grant needs before its turn may run there. */
export const SUPPORT_BOX_CAPABILITIES = {
	/** The box shows a session its checkout read-only, or not at all (`checkout` on a turn frame). */
	checkout: "chatCheckoutModes",
	/** The box keeps a writable working copy of the development branch per room and pushes it (`build.push`). */
	build: "supportBuilds",
	/** The box runs a command on a named host over its own SSH (`host.command`). */
	commands: "hostCommands",
} as const;

export interface SupportRoomView {
	id: string;
	/** The project whose binding attaches the room; an operations room's home, whose box serves it. */
	projectId: string;
	bindingId: string;
	rid: string;
	kind: SupportRoomKind;
	/** An operations room's scope; null for a support group. */
	scope: OperationsScope | null;
	/** The role its bot answers under; null for a support group. */
	role: string | null;
	sessionId: string | null;
	sessionStatus: string | null;
	/** Whether the session's process waits resident on its box for the next message. */
	resident: boolean;
	principalUserId: string;
	toolCount: number;
	/** The group's name on the chat server, where the bot can read it. */
	name: string | null;
	readers: SupportReaders;
	answers: SupportAnswers;
	/** What the room's binding grants (BC-27); a support group without a grant holds no ability. */
	grants: SupportGrants | null;
	health: SupportRoomHealth;
	threads: number;
	latency: SupportLatencyView;
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
	"SUPPORT_NOT_A_SUPPORT_ROOM",
	"OPS_NOT_AN_OPERATIONS_ROOM",
	"OPS_NO_ROLE",
	"OPS_ROLE_NOT_GRANTED",
	"OPS_OUT_OF_SCOPE",
	"OPS_ASKER_UNMAPPED",
	"OPS_ISSUE_UNKNOWN",
	"OPS_RESEARCH_REFUSED",
	"SUPPORT_ABILITY_NOT_GRANTED",
	"SUPPORT_NOT_A_CONFIRMER",
	"SUPPORT_COMMAND_FAILED",
	"SUPPORT_BUILD_REFUSED",
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
	SUPPORT_NOT_A_SUPPORT_ROOM: 409,
	OPS_NOT_AN_OPERATIONS_ROOM: 409,
	OPS_NO_ROLE: 409,
	OPS_ROLE_NOT_GRANTED: 403,
	OPS_OUT_OF_SCOPE: 403,
	OPS_ASKER_UNMAPPED: 403,
	OPS_ISSUE_UNKNOWN: 404,
	SUPPORT_ABILITY_NOT_GRANTED: 403,
	SUPPORT_NOT_A_CONFIRMER: 403,
	SUPPORT_COMMAND_FAILED: 503,
	SUPPORT_BUILD_REFUSED: 409,
} as const satisfies RefusalStatuses<SupportRefusalCode>;
