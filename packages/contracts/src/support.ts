// A project's Rocket.Chat group answered by one Claude session Forge manages (REQ-75 r2). The
// group's members are never Forge users: the session acts as the room's own agent account, reads
// the project's knowledge and published OpenAPI, runs the checks the project grants, proposes the
// fixes it grants and runs one only after the person who asked confirms in chat, and records what
// needs code as Feedback whose result it posts in the same thread once it is live (r6 BC-15).
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
	/** Messages one account may have answered in an hour; past it, one notice in each thread and silence. */
	messagesPerUserPerHour: 30,
	/** Longest message handed to the session; a longer one is cut and says so. */
	messageMaxChars: 4000,
	/** Bytes of a tool's answer handed back to the session. */
	responseMaxBytes: 16_000,
} as const;

export const supportLimitsSchema = z.strictObject({
	messagesPerUserPerHour: z.number().int().min(1).max(1000).optional(),
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
 * names; `ops_reads` runs a read the grant declares by name (ISS-871, REQ-77 BC-3). Policy (VISION
 * kernel-hard-policy-soft); the gate that refuses an ungranted one is core's.
 */
export const SUPPORT_ABILITIES = [
	"read_checkout",
	"file_items",
	"deliver",
	"build",
	"deploy",
	"run_commands",
	"owner_mode",
	"ops_reads",
] as const;
export type SupportAbility = (typeof SUPPORT_ABILITIES)[number];

/** Each ability in the words a refusal, the brief and the settings screen use. */
export const SUPPORT_ABILITY_MEANING: Record<SupportAbility, string> = {
	read_checkout: "read the project's checkout, read-only",
	file_items: "record what needs code as Feedback, once the asker confirms",
	deliver: "move an issue of this project, as the member who asked",
	build:
		"change code in a working copy of the development branch, then commit, push and open a change request into it once a confirmer confirms",
	deploy:
		"deploy a bound target this room names, once a confirmer confirms, and read its deployment record",
	run_commands:
		"run commands on the hosts this room names; a change waits for a confirmer",
	owner_mode:
		"work as a full session for the owner the grant names: code, pull requests and merges, and confirm changes; everyone else reads and asks",
	ops_reads:
		"run the named production reads this room declares (a log search, a fixed data read), at once and read-only, through the box; the tool keeps its own credential",
};

/** Who reads a room: a product's users (no developer detail), or the team the room was bound for. */
export const SUPPORT_READERS = ["users", "team"] as const;
export type SupportReaders = (typeof SUPPORT_READERS)[number];

/**
 * Which messages reach the session: every one, or those that mention the bot and the replies
 * mentioning nobody in a thread the bot has replied in (ISS-985).
 */
export const SUPPORT_ANSWERS = ["every-message", "mentions"] as const;
export type SupportAnswers = (typeof SUPPORT_ANSWERS)[number];

/** A host a room may run commands on: a name this box's SSH resolves, never an option. */
export const supportCommandHostSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/,
		"a host name as the box's SSH names it: letters, digits, . _ -",
	);

/** A Rocket.Chat user id, as the server signs a message with it (`u._id`): never a name a message carries. */
export const chatUserIdSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9._-]{1,64}$/,
		"a Rocket.Chat user id, as the server names the account",
	);

/** A Rocket.Chat username, as the server signs a message with it. */
export const chatUsernameSchema = z
	.string()
	.regex(/^[A-Za-z0-9._-]{1,64}$/, "a Rocket.Chat username, without @");

/** A declared read's name: what the agent calls it by, never a path (ISS-871). */
export const supportReadNameSchema = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]{1,39}$/,
		"a read's name is 2 to 40 lowercase letters, digits and dashes, starting with a letter, such as hub-logs",
	);

/** The program a read runs on the box: an absolute path, never a name the box's PATH resolves. */
const readProgramSchema = z
	.string()
	.max(300)
	.regex(
		/^\/(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/,
		"the program is an absolute path on the box, with no . or .. segment",
	);

/** A fixed argument of a read: words the box passes as they are, one argv item each. */
const readFixedArgSchema = z
	.string()
	.min(1)
	.max(200)
	.refine(
		(v) =>
			[...v].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f),
		"an argument holds no control character",
	);

/**
 * One typed parameter of a declared read (ISS-871): what the agent may pass, checked whole against
 * its pattern or its enum and its length before anything runs, and passed to the program as its own
 * argv item, after its fixed `flag` where one is named, else as the next positional.
 */
export const supportReadParamSchema = z
	.strictObject({
		name: z
			.string()
			.regex(
				/^[a-z][a-z0-9_]{0,31}$/,
				"a parameter name: a lowercase letter, then lowercase letters, digits or _",
			),
		description: z.string().trim().min(3).max(300),
		/** The fixed flag the value follows, such as `--date`; absent, the value is a positional. */
		flag: z
			.string()
			.regex(
				/^--?[A-Za-z0-9][A-Za-z0-9-]{0,39}$/,
				"a flag such as --date or -n",
			)
			.optional(),
		required: z.boolean().optional(),
		/** A regular expression the value must match whole. */
		pattern: z.string().min(1).max(200).optional(),
		/** The only values it takes. */
		enum: z.array(readFixedArgSchema).min(1).max(30).optional(),
		maxLength: z.number().int().min(1).max(500),
	})
	.superRefine((p, ctx) => {
		if ((p.pattern === undefined) === (p.enum === undefined)) {
			ctx.addIssue({
				code: "custom",
				path: ["pattern"],
				message: `parameter ${p.name} takes exactly one of pattern or enum, so every value it passes is checked`,
			});
		}
		if (p.pattern !== undefined) {
			try {
				new RegExp(p.pattern);
			} catch {
				ctx.addIssue({
					code: "custom",
					path: ["pattern"],
					message: "not a regular expression",
				});
			}
		}
	});
export type SupportReadParam = z.infer<typeof supportReadParamSchema>;

/** The longest a read may run on the box, and how long when it names none. */
export const SUPPORT_READ_TIMEOUT_MAX_MS = 120_000;
export const SUPPORT_READ_TIMEOUT_DEFAULT_MS = 60_000;

/**
 * A read a room's grant declares (ISS-871, REQ-77 BC-3): a name the agent calls, a fixed argv the box
 * runs with no shell (`argv[0]` an absolute path), and typed parameters. The program keeps its own
 * credential; the agent sees the name, the summary and the parameters, never the argv.
 */
export const supportReadSchema = z
	.strictObject({
		name: supportReadNameSchema,
		/** What it reads, in words the agent's brief lists. */
		summary: z.string().trim().min(3).max(300),
		argv: z
			.array(readFixedArgSchema)
			.min(1)
			.max(20)
			.refine(
				(argv) => readProgramSchema.safeParse(argv[0]).success,
				"argv[0] is the program: an absolute path on the box, with no . or .. segment",
			),
		params: z
			.array(supportReadParamSchema)
			.max(10)
			.refine(
				(ps) => new Set(ps.map((p) => p.name)).size === ps.length,
				"a parameter is named once",
			)
			.optional(),
		timeoutMs: z
			.number()
			.int()
			.min(1000)
			.max(SUPPORT_READ_TIMEOUT_MAX_MS)
			.optional(),
	})
	.superRefine((r, ctx) => {
		const positional = (r.params ?? []).filter((p) => !p.flag);
		const firstOptional = positional.findIndex((p) => !p.required);
		if (
			firstOptional >= 0 &&
			positional.slice(firstOptional + 1).some((p) => p.required)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["params"],
				message:
					"a required positional parameter follows an optional one, so the program could read one value as the other: put required positionals first",
			});
		}
	});
export type SupportRead = z.infer<typeof supportReadSchema>;

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
		/** Whose plain agreement lets a build, a deploy or a host change run: Rocket.Chat usernames. */
		confirmers: z.array(chatUsernameSchema).max(20).optional(),
		/**
		 * The owner `owner_mode` obeys (REQ-77 BC-20) and a channel agent asks (BC-12): the chat
		 * server's user id for their account, never a name, so a message is the owner's only when the
		 * server signed it so. Named without `owner_mode`, it gives the agent someone to ask, whose
		 * instructions are kept as channel rules (ISS-876), and no other power.
		 */
		owner: chatUserIdSchema.optional(),
		/** The production reads `ops_reads` runs, by name (ISS-871). */
		reads: z
			.array(supportReadSchema)
			.max(20)
			.refine(
				(reads) => new Set(reads.map((r) => r.name)).size === reads.length,
				"two reads share a name; a name names one read",
			)
			.optional(),
	})
	.superRefine((g, ctx) => {
		const has = (a: SupportAbility) => g.abilities.includes(a);
		if (has("ops_reads") !== Boolean(g.reads?.length)) {
			ctx.addIssue({
				code: "custom",
				path: ["reads"],
				message: has("ops_reads")
					? "ops_reads is granted and declares no read: declare the reads this room may run"
					: "reads are declared and ops_reads is not granted: grant ops_reads or drop them",
			});
		}
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
		if (has("owner_mode") && !g.owner) {
			ctx.addIssue({
				code: "custom",
				path: ["owner"],
				message:
					"owner_mode is granted and names no owner: name the owner's Rocket.Chat user id",
			});
		}
		if (
			(has("deploy") || has("run_commands") || has("build")) &&
			!g.confirmers?.length &&
			!has("owner_mode")
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

/** A scheduled check's name: lowercase letters, digits and dashes, as it is named in a group. */
export const supportCheckNameSchema = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9-]{1,39}$/,
		"a check's name is 2 to 40 lowercase letters, digits and dashes, such as morning-check",
	);

/**
 * A check a channel agent runs on a schedule (REQ-77 BC-13): every day at `at` (UTC), in the group
 * `rid`, it is handed `ask` and answers with one finding, which core posts there, or none, and
 * nothing is posted. The AdminHub morning check is one.
 */
export const supportCheckSchema = z.strictObject({
	name: supportCheckNameSchema,
	/** The group the finding is posted in: one of the binding's `rids`. */
	rid: z.string().min(1).max(200),
	/** When it runs each day, `HH:MM` in UTC. */
	at: z
		.string()
		.regex(
			/^([01]\d|2[0-3]):[0-5]\d$/,
			"a check's time is HH:MM in UTC, such as 01:30",
		),
	/** What the agent checks, and what counts as a finding, in the owner's words. */
	ask: z.string().trim().min(10).max(2000),
});
export type SupportCheck = z.infer<typeof supportCheckSchema>;

/**
 * The `support` block of a `rocketchat` binding: present, the binding's one room is a support group
 * answered by the session; absent, the room is the team assistant's, as before.
 */
/** The most sibling projects one channel agent follows (ISS-874). */
export const SUPPORT_AGENT_PROJECTS_MAX = 10;

/** A project a support session names, by slug: a channel agent's home when omitted (ISS-874). */
export const supportProjectSlugSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.describe("a project you follow, by slug; your home project when omitted");

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
	/**
	 * What the room's agent is handed to tell the room (ISS-854): `releases`, each release that reaches
	 * production, as its user-facing notes, for the agent to write in its own words. Off when absent.
	 */
	announce: z.strictObject({ releases: z.boolean().optional() }).optional(),
	/**
	 * The group, one of the binding's `rids`, where a channel agent asks the owner (`agent` block
	 * only, ISS-872): `ask_owner` posts nowhere else, and this group's readers are the owner, whatever
	 * `readers` says of the others.
	 */
	ownerRoom: z.string().min(1).max(200).optional(),
	/**
	 * The sibling projects a channel agent follows besides its home project (`agent` block only,
	 * ISS-874), by slug, each of the home project's organization: it reads each one's tracker,
	 * knowledge and code, and files a record to the one it names. The home project is always in the
	 * set and is not named here.
	 */
	projects: z
		.array(supportProjectSlugSchema)
		.min(1)
		.max(SUPPORT_AGENT_PROJECTS_MAX)
		.refine((p) => new Set(p).size === p.length, "a project is named once")
		.optional(),
	/**
	 * Per group, who reads it and which messages reach the agent (`agent` block only, ISS-874), by
	 * rid, each one of the binding's `rids`: one agent hears every message of a users' group and only
	 * mentions in a team group. A group named nowhere here takes `readers` and `answers` above.
	 */
	rooms: z
		.record(
			z.string().min(1).max(200),
			z.strictObject({
				readers: z.enum(SUPPORT_READERS).optional(),
				answers: z.enum(SUPPORT_ANSWERS).optional(),
			}),
		)
		.optional(),
	/** Scheduled checks: a channel agent's (`agent` block) only (REQ-77 BC-13). */
	checks: z
		.array(supportCheckSchema)
		.max(10)
		.refine(
			(checks) => new Set(checks.map((c) => c.name)).size === checks.length,
			"a check is named once",
		)
		.optional(),
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
		/** What it does, in words the session reads in the tools list and says to the asker in its own. */
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
 * `feedback_recorded` an item filed, `refused` a refusal the room was told of, `operation` an
 * operations room's act (its action in `tool`). REQ-75 r6: `channel_written` the session wrote the
 * channel record (its act in `tool`), `routed` a need sent to Forge, Technical or Product,
 * `announced` the one top-level post, `secret_flagged` a posted secret flagged to Technical,
 * `result_told` the session told a recorded item's result. `progress_posted` is a progress line
 * posted before r6 (BC-15 now forbids progress); nothing writes it.
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
	"channel_written",
	"routed",
	"announced",
	"secret_flagged",
	"result_told",
	/** A channel agent's one result for one firing of a scheduled check (REQ-77 BC-13). */
	"check_result",
	/** The finding core posted in the group for a check result (REQ-77 BC-13). */
	"check_posted",
	/** The session promised a person to tell them when an issue reaches an environment (ISS-1012). */
	"promise_made",
	/** Core told the session a promise's answer: reached, dropped, or no longer tracked (ISS-1012). */
	"promise_told",
] as const;
export type SupportActionKind = (typeof SUPPORT_ACTION_KINDS)[number];

/** Who took an action: a group member (by their Rocket.Chat account), the session, or core itself. */
export const SUPPORT_ACTOR_KINDS = ["member", "session", "core"] as const;
export type SupportActorKind = (typeof SUPPORT_ACTOR_KINDS)[number];

/**
 * What waits on an agreement: a granted `fix`, or a `filing` of what needs code as Feedback, each on
 * its asker's; a `deploy` of a bound target, a `build`, or a `command` that changes a host, each on a
 * confirmer the room's grant names (REQ-75 r5 BC-27). All share one handle space per room, so one
 * `agree` names one of them (ISS-845).
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

/**
 * A proposal's handle: what the session names when it cites the agreement to it (ISS-845). Nobody in
 * the room types it; unambiguous letters and digits.
 */
export const SUPPORT_CONFIRM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

/** What the session records an item as: the kinds a group member's need maps to. */
export const SUPPORT_RECORD_KINDS = ["defect", "feature", "request"] as const;
export type SupportRecordKind = (typeof SUPPORT_RECORD_KINDS)[number];

/**
 * How many pictures a room message carries and how large each is, wherever core reads or posts them:
 * the chat-room Assistant's turn, a support session's read (ISS-1010) and a master's post (ISS-1024).
 */
export const ROOM_IMAGE_CAPS = { perMessage: 4, bytes: 4_000_000 } as const;

/** The picture types a room message's image is read or posted as; svg is a document, never one. */
export const ROOM_IMAGE_MIMES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

export const supportThreadIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
	.describe(
		"the thread: the id the message you answer carries as `thread` in what you were handed",
	);
const threadId = supportThreadIdSchema;

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
	"deployment",
	"project",
	"command",
	"channel",
	"member",
	"rule",
	"common_issue",
	"route",
	"announce",
	"ask_owner",
	"answer_question",
	"check_result",
	"agree",
	"link",
	"read",
	"image",
	"promise",
] as const;
export type SupportAction = (typeof SUPPORT_ACTIONS)[number];

export const supportSearchRequestSchema = z.strictObject({
	query: z.string().trim().min(2).max(300),
	project: supportProjectSlugSchema.optional(),
});
/** A channel agent's read of a project document (ISS-775): its home's, or a project it follows. */
export const supportProjectRequestSchema = z.strictObject({
	project: supportProjectSlugSchema.optional(),
});
export const supportThreadRequestSchema = z.strictObject({ thread: threadId });

/**
 * A picture a member's message carries, read through Forge (ISS-1010): core fetches it from the
 * chat server with the bot's credential, which the session's box never holds.
 */
export const supportImageRequestSchema = z.strictObject({
	message: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
		.describe(
			"the message carrying the picture, as you were handed it (`message`)",
		),
	n: z
		.number()
		.int()
		.min(1)
		.max(16)
		.optional()
		.describe(
			"which of its pictures, 1 to the `images.count` you were handed; 1 when omitted",
		),
});
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
	/** The project whose master it is for (ISS-874): a project you follow; your home when omitted. */
	project: supportProjectSlugSchema.optional(),
});

/**
 * The person's plain answer to a proposal, as the session cites it (ISS-845): the proposal's handle
 * and the id of the message in which they agreed or declined, in their own words. Core checks who
 * wrote that message, in which thread and when, before anything runs.
 */
export const supportAgreeRequestSchema = z.strictObject({
	thread: threadId,
	proposal: z
		.string()
		.regex(
			SUPPORT_CONFIRM_CODE_PATTERN,
			"a proposal handle, as `record`, `propose_fix`, `build`, `deploy` or `command` answered it",
		)
		.describe(
			"the proposal the person answered: the `proposal` its act answered",
		),
	message: z
		.string()
		.min(1)
		.max(64)
		.describe(
			"the id of the person's message that agrees or declines, as you were handed it (`message`)",
		),
	decision: z.enum(["agree", "decline"]).optional(),
});

/**
 * A member's chat account to link to their Forge user (ISS-845): the session is handed the link page
 * to give them, where they confirm it signed in; no code passes through the room or the session.
 */
export const supportLinkRequestSchema = z.strictObject({
	thread: threadId,
	member: z
		.string()
		.min(1)
		.max(64)
		.describe(
			"the member's chat account id, as you were handed it (`from.id`)",
		),
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
/**
 * A promise to tell a person, in their thread, when an issue of a project the room follows reaches
 * an environment, named as that project's document names it (ISS-1012). No deployment target id.
 */
export const supportPromiseRequestSchema = z.strictObject({
	thread: threadId,
	issue: supportMoveIssueRequestSchema.shape.issue.describe(
		"an issue of a project you follow, by its key, e.g. ISS-12",
	),
	environment: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.describe(
			"the environment by the project's own name for it, as its document declares it (staging, production)",
		),
	/** The member to tell: their account id; the thread's first writer when omitted. */
	asker: z.string().min(1).max(64).optional(),
	/** The issue's project: a project you follow; read from the key's prefix when omitted. */
	project: supportProjectSlugSchema.optional(),
});
export type SupportPromiseRequest = z.infer<typeof supportPromiseRequestSchema>;

/** The states a promise is in: waiting, or answered once and never again (ISS-1012). */
export const SUPPORT_PROMISE_STATES = [
	"open",
	"reached",
	"dropped",
	"untracked",
] as const;
export type SupportPromiseState = (typeof SUPPORT_PROMISE_STATES)[number];

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
/** The latest deployment record of a deploy binding the room's grant names (ISS-775). */
export const supportDeploymentRequestSchema = z.strictObject({
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

/**
 * A declared read, run by name (ISS-871): `args` by parameter name; `thread` the member thread it
 * answers, or `check` the scheduled check it serves, either recorded with it.
 */
export const supportReadRequestSchema = z.strictObject({
	name: supportReadNameSchema.describe(
		"a read this room's grant declares, as your brief lists it",
	),
	args: z
		.record(z.string(), z.union([z.string(), z.number()]))
		.optional()
		.describe("the read's parameters by name, as your brief lists them"),
	thread: threadId.optional(),
	check: z
		.string()
		.regex(
			/^check:[a-z0-9][a-z0-9-]{1,39}:\d{4}-\d{2}-\d{2}$/,
			"the check as it was handed: check:<name>:<YYYY-MM-DD>",
		)
		.optional(),
});

/** What a declared read came back with: its name and what the program printed, scrubbed by core. */
export interface SupportReadResult {
	name: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	durationMs: number;
}

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
 * off, or no longer names the room's group; the chat server refuses the bot or does not answer; the
 * bot is not a member of the group; no core process holds the bot's live connection; no online box
 * of the project can run the session, or it lacks what the room's grants need; the session is not
 * resident on its box.
 */
export const SUPPORT_HEALTH_CAUSES = [
	"BINDING_OFF",
	"ROOM_LEFT_BINDING",
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
	/** The box runs a read a grant declares, from its fixed argv with no shell (`ops.read`, ISS-871). */
	reads: "opsReads",
	/**
	 * The box runs an owner-mode channel agent confined in its own clone of the repository, pushing
	 * with a credential for that repository alone (ISS-765).
	 */
	owner: "ownerCheckouts",
	/**
	 * The box shows a channel agent the checkouts of the projects it follows, read-only, beside its
	 * own (`siblingCheckouts` on a turn frame, ISS-874).
	 */
	siblings: "siblingCheckouts",
} as const;

/**
 * One support API the project grants its rooms (ISS-1011): a project may bind several, one per
 * credential (one Agenfold workspace each), and each tool reads the one that grants it.
 */
export interface SupportApiView {
	bindingId: string;
	/** Its label, else its connection's name: what the room calls it. */
	name: string;
	tools: { name: string; kind: SupportToolKind }[];
	/** Why the support door cannot call it as stored; null where it can. */
	fault: string | null;
}

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
	/** Every support API the project grants, oldest first, each with the tools it serves. */
	supportApis: SupportApiView[];
	/** The group's name on the chat server, where the bot can read it. */
	name: string | null;
	readers: SupportReaders;
	answers: SupportAnswers;
	/** What the room's binding grants (BC-27); a support group without a grant holds no ability. */
	grants: SupportGrants | null;
	health: SupportRoomHealth;
	/** The threads Forge has recorded a message or an act in, in this room. */
	threads: number;
	/**
	 * This project's own thread in an operations room, as the room's binding records it in
	 * `operations.threads` (ISS-934): where the master's posts and the room's top-level posts land.
	 * Null in any other room, or where none is recorded.
	 */
	projectThread: string | null;
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
	"SUPPORT_NOT_A_SUPPORT_ROOM",
	/** No proposal waits under the handle an agreement names: it ran, was declined, expired or never was (ISS-845). */
	"SUPPORT_PROPOSAL_UNKNOWN",
	/** The proposal's time ran out before anyone agreed to it (ISS-845). */
	"SUPPORT_PROPOSAL_EXPIRED",
	/** The cited message, or the act, is in another thread than the proposal's (ISS-845). */
	"SUPPORT_AGREEMENT_OTHER_THREAD",
	/** The cited message was written before the proposal was made, so it agrees to nothing (ISS-845). */
	"SUPPORT_AGREEMENT_BEFORE_PROPOSAL",
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
	"SUPPORT_MEMBER_CONFIRMED",
	"SUPPORT_MENTION_REFUSED",
	"SUPPORT_CHANNEL_PRIVATE_DATA",
	"SUPPORT_MESSAGE_UNKNOWN",
	"SUPPORT_RULE_AUTHOR",
	"SUPPORT_NOT_REPEATED",
	"SUPPORT_FEEDBACK_UNKNOWN",
	"SUPPORT_ROUTE_ROLE",
	"SUPPORT_ANNOUNCE_LIMIT",
	"SUPPORT_CHANNEL_UNKNOWN",
	"SUPPORT_RULE_UNKNOWN",
	"SUPPORT_CHANNEL_NOT_OUTSIDE",
	/** A channel agent serves several groups, and the act named none it could be read from (REQ-77). */
	"SUPPORT_ROOM_AMBIGUOUS",
	/** A channel agent's second reply to one request: one result per request (REQ-77 BC-8). */
	"SUPPORT_ONE_RESULT_PER_REQUEST",
	/** The binding names no owner to ask (REQ-77 BC-12). */
	"SUPPORT_OWNER_NOT_NAMED",
	/** An owner question's `record` names no issue of this project (REQ-77 BC-12). */
	"SUPPORT_OWNER_RECORD_UNKNOWN",
	/** An owner question's `forgeQuestion` names no open question of this project (ISS-871). */
	"SUPPORT_OWNER_QUESTION_UNKNOWN",
	/** A git credential asked by a session that is no channel agent in owner mode (ISS-765). */
	"SUPPORT_GIT_NOT_OWNER_MODE",
	/** A git credential asked for a repository other than the project's own (ISS-765). */
	"SUPPORT_GIT_NOT_OWN_REPO",
	/** A check result names no scheduled check of this group (REQ-77 BC-13). */
	"SUPPORT_CHECK_UNKNOWN",
	/** A second result for one firing of a scheduled check (REQ-77 BC-13). */
	"SUPPORT_CHECK_ANSWERED",
	/** No switch is planned for the group (REQ-77 BC-16). */
	"AGENT_SWITCH_UNKNOWN",
	/** A duty, the earlier switch or the owner's word still stands between the group and its switch (BC-16..BC-19). */
	"AGENT_SWITCH_NOT_READY",
	/** The group already switched: its plan no longer changes. */
	"AGENT_SWITCH_DONE",
	/** The group has not switched yet, so it cannot be proven. */
	"AGENT_SWITCH_NOT_SWITCHED",
	/** A plan names no such duty, or an earlier switch that is not one. */
	"AGENT_SWITCH_PLAN_REFUSED",
	/** The chat server did not remove the outside bot from the group, so nothing switched. */
	"AGENT_SWITCH_BOT_NOT_REMOVED",
	/** No binding of the project carries a channel agent to switch the group to. */
	"AGENT_SWITCH_NO_AGENT",
	/** A duty names a box path, key or host the confined agent never sees (ISS-775). */
	"AGENT_SWITCH_DUTY_NAMES_BOX",
	/** The outside bot is the binding's own account and its process is not recorded stopped (ISS-775). */
	"AGENT_SWITCH_OUTSIDE_RUNNING",
	/** A stop record for an outside bot on another account, which the switch removes itself (ISS-775). */
	"AGENT_SWITCH_OUTSIDE_NOT_SELF",
	/** The deploy binding's deployment record could not be read (ISS-775). */
	"SUPPORT_DEPLOYMENT_UNREADABLE",
	/** An act only a channel agent takes, asked by a support group's session (ISS-775). */
	"SUPPORT_NOT_A_CHANNEL_AGENT",
	/** A read the room's grant does not declare (ISS-871). */
	"SUPPORT_READ_UNDECLARED",
	/** A read's argument outside its parameter's pattern, enum or length, unknown, or missing (ISS-871). */
	"SUPPORT_READ_ARGS",
	/** The box could not run a declared read (ISS-871). */
	"SUPPORT_READ_FAILED",
	/** A post holds an internal code outside a team member's own thread (ISS-872, ISS-873). */
	"SUPPORT_INTERNAL_CODE",
	/** A master's top-level post into a room the product's users read (ISS-872). */
	"SUPPORT_MASTER_POST_USERS_ROOM",
	/** A master's post into a room its project held once, whose binding is switched off or no longer names it (ISS-943). */
	"SUPPORT_ROOM_SWITCHED_OFF",
	/** A master's post into a thread whose first message the chat server places in another room than the one named (ISS-943). */
	"SUPPORT_THREAD_OF_ANOTHER_ROOM",
	/** A master's post into an operations room shared by projects, with no thread recorded for its project (ISS-934). */
	"SUPPORT_PROJECT_THREAD_UNRECORDED",
	/** A question for the owner outside the room the binding names as `ownerRoom` (ISS-872). */
	"SUPPORT_NOT_THE_OWNER_ROOM",
	/** A thread that names no parked question handed to this group (ISS-873). */
	"SUPPORT_QUESTION_UNKNOWN",
	/** An answer naming neither or both of where it is: the record, or the owner's message (ISS-873). */
	"SUPPORT_ANSWER_SOURCE",
	/** A message the owner did not write in this group, cited as their answer (ISS-873). */
	"SUPPORT_ANSWER_NOT_THE_OWNER",
	/** The question was already asked and waits in the owner's room (ISS-873). */
	"SUPPORT_OWNER_ALREADY_ASKED",
	/** No thread for the day's questions is open yet, and the ask carries no line to open it (ISS-873). */
	"SUPPORT_DAY_THREAD_OPENER",
	/** The message carries no picture at that place (ISS-1010). */
	"SUPPORT_IMAGE_UNKNOWN",
	/** The picture is larger than a session reads (ISS-1010). */
	"SUPPORT_IMAGE_TOO_LARGE",
	/** The chat server holds the picture no longer (ISS-1010). */
	"SUPPORT_IMAGE_GONE",
	/** The chat server refused the bot's credential for the picture (ISS-1010). */
	"SUPPORT_IMAGE_REFUSED",
	/** The picture is named on another host than the room's chat server, which is never sent the bot's credential (ISS-1010). */
	"SUPPORT_IMAGE_OFF_SERVER",
	/** The chat server could not be read for the picture (ISS-1010). */
	"SUPPORT_IMAGE_UNREACHABLE",
	/** A master's post names an image no issue, comment or session upload has (ISS-1024). */
	"SUPPORT_POST_IMAGE_UNKNOWN",
	/** A master's post names an upload of a project its caller cannot read (ISS-1024). */
	"SUPPORT_POST_IMAGE_UNREADABLE",
	/** A master's post names an upload that is no png, jpeg, gif or webp (ISS-1024). */
	"SUPPORT_POST_IMAGE_NOT_AN_IMAGE",
	/** A master's post names an image larger than a room's picture (ISS-1024). */
	"SUPPORT_POST_IMAGE_TOO_LARGE",
	/** A master's post names an upload whose file is gone from storage (ISS-1024). */
	"SUPPORT_POST_IMAGE_FILE_MISSING",
	/** The chat server took no image of a master's post (ISS-1024). */
	"SUPPORT_POST_IMAGE_UNPOSTED",
	/** A promise naming an issue of a project the room does not follow (ISS-1012). */
	"SUPPORT_PROMISE_NOT_FOLLOWED",
	/** A promise naming no issue of the project its key or `project` names (ISS-1012). */
	"SUPPORT_PROMISE_ISSUE_UNKNOWN",
	/** A promise about an issue already dropped, which will never reach any environment (ISS-1012). */
	"SUPPORT_PROMISE_ISSUE_DROPPED",
	/** A promise naming an environment the project does not declare, or whose serving Forge cannot read (ISS-1012). */
	"SUPPORT_PROMISE_ENVIRONMENT_UNTRACKED",
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
	SUPPORT_MEMBER_CONFIRMED: 409,
	SUPPORT_MENTION_REFUSED: 409,
	SUPPORT_CHANNEL_PRIVATE_DATA: 400,
	SUPPORT_MESSAGE_UNKNOWN: 404,
	SUPPORT_RULE_AUTHOR: 403,
	SUPPORT_NOT_REPEATED: 409,
	SUPPORT_FEEDBACK_UNKNOWN: 404,
	SUPPORT_ROUTE_ROLE: 409,
	SUPPORT_ANNOUNCE_LIMIT: 409,
	SUPPORT_CHANNEL_UNKNOWN: 404,
	SUPPORT_RULE_UNKNOWN: 404,
	SUPPORT_CHANNEL_NOT_OUTSIDE: 409,
	SUPPORT_ROOM_AMBIGUOUS: 400,
	SUPPORT_ONE_RESULT_PER_REQUEST: 409,
	SUPPORT_OWNER_NOT_NAMED: 409,
	SUPPORT_OWNER_RECORD_UNKNOWN: 404,
	SUPPORT_OWNER_QUESTION_UNKNOWN: 404,
	SUPPORT_GIT_NOT_OWNER_MODE: 403,
	SUPPORT_GIT_NOT_OWN_REPO: 403,
	SUPPORT_CHECK_UNKNOWN: 404,
	SUPPORT_CHECK_ANSWERED: 409,
	AGENT_SWITCH_UNKNOWN: 404,
	AGENT_SWITCH_NOT_READY: 409,
	AGENT_SWITCH_DONE: 409,
	AGENT_SWITCH_NOT_SWITCHED: 409,
	AGENT_SWITCH_PLAN_REFUSED: 400,
	AGENT_SWITCH_BOT_NOT_REMOVED: 503,
	AGENT_SWITCH_NO_AGENT: 409,
	AGENT_SWITCH_DUTY_NAMES_BOX: 400,
	AGENT_SWITCH_OUTSIDE_RUNNING: 409,
	AGENT_SWITCH_OUTSIDE_NOT_SELF: 409,
	SUPPORT_DEPLOYMENT_UNREADABLE: 503,
	SUPPORT_NOT_A_CHANNEL_AGENT: 409,
	SUPPORT_READ_UNDECLARED: 404,
	SUPPORT_READ_ARGS: 400,
	SUPPORT_READ_FAILED: 503,
	SUPPORT_INTERNAL_CODE: 400,
	SUPPORT_MASTER_POST_USERS_ROOM: 409,
	SUPPORT_ROOM_SWITCHED_OFF: 409,
	SUPPORT_THREAD_OF_ANOTHER_ROOM: 409,
	SUPPORT_PROJECT_THREAD_UNRECORDED: 409,
	SUPPORT_NOT_THE_OWNER_ROOM: 409,
	SUPPORT_QUESTION_UNKNOWN: 404,
	SUPPORT_ANSWER_SOURCE: 400,
	SUPPORT_ANSWER_NOT_THE_OWNER: 409,
	SUPPORT_OWNER_ALREADY_ASKED: 409,
	SUPPORT_DAY_THREAD_OPENER: 409,
	SUPPORT_IMAGE_UNKNOWN: 404,
	SUPPORT_IMAGE_TOO_LARGE: 409,
	SUPPORT_IMAGE_GONE: 404,
	SUPPORT_IMAGE_REFUSED: 503,
	SUPPORT_IMAGE_OFF_SERVER: 409,
	SUPPORT_IMAGE_UNREACHABLE: 503,
	SUPPORT_POST_IMAGE_UNKNOWN: 404,
	SUPPORT_POST_IMAGE_UNREADABLE: 403,
	SUPPORT_POST_IMAGE_NOT_AN_IMAGE: 400,
	SUPPORT_POST_IMAGE_TOO_LARGE: 400,
	SUPPORT_POST_IMAGE_FILE_MISSING: 404,
	SUPPORT_POST_IMAGE_UNPOSTED: 503,
	SUPPORT_PROMISE_NOT_FOLLOWED: 403,
	SUPPORT_PROMISE_ISSUE_UNKNOWN: 404,
	SUPPORT_PROMISE_ISSUE_DROPPED: 409,
	SUPPORT_PROMISE_ENVIRONMENT_UNTRACKED: 409,
} as const satisfies RefusalStatuses<SupportRefusalCode>;
