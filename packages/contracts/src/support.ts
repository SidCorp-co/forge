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
import { REASON_LINE_MAX, REASON_PARAGRAPH_MAX } from "./reason-text.js";
import type { RefusalStatuses } from "./refusal.js";
import { secretShapeSchema } from "./secret-slots.js";
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

/**
 * The program a read runs on the box: an absolute path, never a name the box's PATH resolves; or
 * `repo:<path>`, a program versioned in the project's own repository, run from the checkout the box
 * binds to the project, so any runner of the project runs the same reviewed code (ISS-707).
 */
export const READ_REPO_PROGRAM_PREFIX = "repo:";
const readProgramSchema = z
	.string()
	.max(300)
	.regex(
		/^(?:\/|repo:)(?!.*(?:^|\/|:)\.\.?(?:\/|$))[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/,
		"the program is an absolute path on the box, or repo:<path> in the project's checkout, with no . or .. segment",
	);

/**
 * A project secret a read's own process is handed as one environment variable (ISS-707): the box
 * sets it on that process alone, the agent never sees it, and what the read prints is scrubbed of it.
 */
export const supportReadSecretSchema = z.strictObject({
	env: z
		.string()
		.regex(
			/^[A-Z][A-Z0-9_]{0,63}$/,
			"an environment variable name: a capital letter, then capitals, digits or _",
		),
	secret: z
		.string()
		.regex(
			/^secret:\/\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/,
			"a project secret by ref: secret://<scope>/<name>",
		),
});
export type SupportReadSecret = z.infer<typeof supportReadSecretSchema>;

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
		/** The project secrets its process is handed, each as one variable (ISS-707). */
		secrets: z
			.array(supportReadSecretSchema)
			.min(1)
			.max(5)
			.refine(
				(ss) => new Set(ss.map((x) => x.env)).size === ss.length,
				"two secrets share a variable; a variable is named once",
			)
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

/**
 * Which messages of group `rid` a `support` or `agent` block answers: its own word for the group,
 * else the block's, else every message. Core's room reads and its binding check both read this one.
 */
export function answersOfBlock(
	block: Pick<SupportRoomConfig, "answers" | "rooms"> | null | undefined,
	rid: string,
): SupportAnswers {
	return block?.rooms?.[rid]?.answers ?? block?.answers ?? "every-message";
}

/**
 * A tool's kind: `diagnose` reads (GET or HEAD only) and runs at once; `fix` waits on the asker;
 * `owner` acts in the product as its owner (REQ-85, ISS-1013), only in the owner's room while his
 * consent stands, and core calls it with the owner's credential it keeps for the binding, never the
 * binding's own.
 */
export const SUPPORT_TOOL_KINDS = ["diagnose", "fix", "owner"] as const;
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
		/**
		 * An owner tool the product gates on a person's approval (a key code, a destructive change):
		 * core runs it only on the owner's plain agreement, asked in his thread and cited (ISS-1014,
		 * design support-owner-acts step approval-gate).
		 */
		approval: z.boolean().optional(),
	})
	.superRefine((tool, ctx) => {
		if (tool.approval && tool.kind !== "owner") {
			ctx.addIssue({
				code: "custom",
				path: ["approval"],
				message: `approval gates an owner act on its owner's agreement, and ${tool.name} is kind ${tool.kind}`,
			});
		}
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

/**
 * Where core keeps the owner's credential for one product (ISS-1013, REQ-85 BC-2, BC-4): a project
 * secret under this scope, named for the support-api binding, holding `{ headers }` as
 * `supportApiSecretsSchema` reads it. Written only at the owner-credential door, which checks the
 * shape and the binding; never handed to a room's session or its box.
 */
export const SUPPORT_OWNER_CREDENTIAL_SCOPE = "owner-acts";
export const supportOwnerCredentialName = (bindingId: string) =>
	`binding-${bindingId.toLowerCase()}`;

/**
 * Where core keeps a credential a person hands over in a bound room (ISS-1372): a project secret
 * under this scope, `secret://kept/<name>`, stored before the message is redacted and read by the
 * project's master and its runs at the acting door once usable. Written only by the room's intake.
 */
export const SUPPORT_KEPT_SECRET_SCOPE = "kept";

/** How long a kept credential a non-admin sent waits for a project admin's approval (ISS-1372). */
export const SUPPORT_KEPT_PENDING_HOURS = 24;

const ownerTokenSchema = z.string().min(1).max(4000);

/**
 * The owner's OAuth credential as core keeps it (ISS-1047, REQ-85 BC-2): the access token core
 * sends as `Authorization: Bearer`, the refresh token it rotates the access token with, and when the
 * access token expires (null where the product did not say, so it is refreshed before each act).
 */
export const supportOwnerOauthSchema = z.strictObject({
	accessToken: ownerTokenSchema,
	refreshToken: ownerTokenSchema.optional(),
	expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
export type SupportOwnerOauth = z.infer<typeof supportOwnerOauthSchema>;

/**
 * Everything the owner-acts scope may hold for one product: static `headers` (ISS-1013), an `oauth`
 * credential core refreshes (ISS-1047), or an `ended` one, whose refresh the product refused: no
 * token is kept, and the owner signs in again before the room acts as him there.
 */
export const supportOwnerCredentialSchema = z.union([
	supportApiSecretsSchema,
	z.strictObject({ oauth: supportOwnerOauthSchema }),
	z.strictObject({
		ended: z.strictObject({
			at: z.iso.datetime({ offset: true }),
			reason: z.string().min(1).max(REASON_LINE_MAX),
		}),
	}),
]);
export type SupportOwnerCredential = z.infer<
	typeof supportOwnerCredentialSchema
>;

/**
 * The owner-credential door's body: the headers core sends as the owner on every owner act, or the
 * owner's OAuth tokens, which core refreshes before an act where the binding declares `ownerSignIn`.
 * Exactly one of the two; the door refuses both or neither by name.
 */
export const supportOwnerCredentialRequestSchema = z.strictObject({
	headers: supportApiSecretsSchema.shape.headers.optional(),
	oauth: z
		.strictObject({
			accessToken: ownerTokenSchema,
			refreshToken: ownerTokenSchema.optional(),
			/** Seconds the access token lives from now, as the product's token answer gave it. */
			expiresIn: z.number().int().positive().max(31_536_000).optional(),
		})
		.optional(),
});

const oauthEndpoint = z
	.url()
	.max(500)
	.regex(/^https?:\/\//, "an http(s) URL");

/**
 * The owner's own account at the product (ISS-1052, REQ-85 BC-1): the `sub` or the `email` the
 * product names whoever signed in by, in its id_token or at its userinfo endpoint. A sign-in made by
 * any other account keeps nothing and records no consent.
 */
export const supportOwnerAccountSchema = z.strictObject({
	claim: z.enum(["sub", "email"]),
	value: z.string().trim().min(1).max(320),
});
export type SupportOwnerAccount = z.infer<typeof supportOwnerAccountSchema>;

/**
 * How the owner signs in to the product (ISS-1047, REQ-85 BC-3): its OAuth 2.0 authorization
 * endpoint (authorization code with PKCE, S256), its token endpoint, which must be on a host the
 * connection grants, the public client Forge is registered as, and the scopes asked for. The product
 * registers `<Forge API origin>/api/support/owner-sign-in/callback` as that client's redirect.
 * ISS-1052: `owner` names the owner's own account there, and core reads who signed in from the
 * id_token (the `openid` scope) or from `userinfoUrl`; `issuer` is the id_token's `iss` where it is
 * not the token endpoint's origin. A binding naming no owner starts no sign-in.
 */
export const supportOwnerSignInSchema = z.strictObject({
	authorizationUrl: oauthEndpoint,
	tokenUrl: oauthEndpoint,
	userinfoUrl: oauthEndpoint.optional(),
	issuer: oauthEndpoint.optional(),
	owner: supportOwnerAccountSchema.optional(),
	clientId: z.string().min(1).max(200),
	scopes: z
		.array(
			z
				.string()
				.regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,100}$/, "an OAuth scope token"),
		)
		.max(20)
		.optional(),
});
export type SupportOwnerSignIn = z.infer<typeof supportOwnerSignInSchema>;

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
	ownerSignIn: supportOwnerSignInSchema.optional(),
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
	/** The owner consented, in his own words in his room, to the room acting as him in a product (ISS-1013). */
	"owner_consented",
	/** The owner withdrew that consent, and the room acts as him no more (ISS-1013). */
	"owner_withdrew",
	/** Core made an act in the product as the owner, with the credential it keeps (ISS-1013). */
	"owner_act",
	/** Core started the owner's sign-in to a product, for the session to hand him (ISS-1047). */
	"owner_sign_in",
	/** The owner confirmed the sign-in core started, and core keeps the credential it gave (ISS-1047). */
	"owner_signed_in",
	/**
	 * The owner's cited answer to a Forge question, kept because his chat account is no Forge account
	 * yet, and recorded as his once it is (ISS-976); `output` says what became of it.
	 */
	"answer_kept",
	/** The session chose to post nothing for a message it was handed, with its reason (ISS-942). */
	"silent",
	/**
	 * The session's routing decision for a message it was handed (ISS-1243): the project chosen, the
	 * signals used, its confidence, and answer, gather, ask or silent with why.
	 */
	"routing_decided",
	/**
	 * A person redacted a secret kept unscrubbed in a member's message (ISS-1353): `input` names the
	 * action and the reason, `actorKey` the Forge account that did it.
	 */
	"secret_redacted",
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

/**
 * The document a master's post may carry besides pictures (ISS-1238, FB-643): a PDF, such as a
 * multi-step user guide in one file. A master's post alone takes it; a member's picture the channel
 * agent reads is still one of `ROOM_IMAGE_MIMES`.
 */
export const ROOM_DOCUMENT_MIMES = ["application/pdf"] as const;

/** How large a master's post's PDF is at most (ISS-1238). */
export const ROOM_DOCUMENT_CAPS = { bytes: 10_000_000 } as const;

/** How long after posting a master may edit or delete its own room post (ISS-1238). */
export const SUPPORT_MASTER_POST_EDIT_WINDOW_MS = 30 * 60_000;

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
	"owner_consent",
	"owner_act",
	"owner_sign_in",
	"release_decision",
	"owner_forge_act",
	"silent",
	"decide",
	"approve",
	"ask_master",
	"in_flight",
	"raise_owed",
	"technical",
	"asker",
	"audit",
	"guide",
	// a project's reference sources: read first, cite a use, add one a person names, propose one (ISS-1252)
	"references",
	"reference_add",
	"reference_cite",
	"reference_propose",
	// a term a person names, written into the project's glossary under its module (ISS-1256)
	"term",
	// a Forge link where a person enters a credential for the project's testing profile (ISS-1328)
	"secret_link",
] as const;

/** The kinds of slot the one secret door opens (ISS-1348). */
export const SECRET_SLOT_KINDS = [
	"variable",
	"testing",
	"integration",
] as const;
export type SecretSlotKind = (typeof SECRET_SLOT_KINDS)[number];

/** How a slot was given its value: through its page in Forge, or a one-time write URL. */
export const SECRET_WRITE_VIAS = ["page", "presigned"] as const;

const slotName = (what: string) =>
	z
		.string()
		.regex(/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/, what)
		.optional();

/**
 * The one secret door (ISS-1328, ISS-1348): the slot a person gives a value for, by kind, and core
 * builds the link that opens that one field — a variable at one environment (REQ-80), a testing
 * profile's actor or service, or an integration's credential. A slot not held yet opens as a new one
 * with its key and scope filled. With `presign`, the answer also carries a one-time write URL for that
 * slot alone (PUT the value as the body; short-lived, single use, write-only). The value never passes
 * through chat; the thread hears that it was filled, by fingerprint. `project` names a project of the
 * room's scope (ISS-1346); the room's own where omitted.
 */
export const supportSecretLinkRequestSchema = z.strictObject({
	thread: threadId,
	project: supportProjectSlugSchema.optional(),
	kind: z
		.enum(SECRET_SLOT_KINDS)
		.describe(
			"variable (an environment variable: environment, key), testing (a testing profile's credential: profile, actor | service) or integration (a connection's credential: provider)",
		),
	environment: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,62}$/, "an environment the project declares")
		.nullable()
		.optional()
		.describe(
			"variable: the environment it is scoped to, or null for every environment",
		),
	key: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/, "an environment variable name")
		.optional()
		.describe("variable: its key"),
	profile: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,62}$/, "a testing profile id")
		.optional()
		.describe("testing: the profile, by its id"),
	actor: slotName("an actor name").describe(
		"testing: the actor the value signs in as; or service",
	),
	service: slotName("a service name").describe(
		"testing: the service the value is a key of; or actor",
	),
	provider: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,62}$/, "an integration provider")
		.optional()
		.describe("integration: the provider whose connection the project binds"),
	presign: z
		.boolean()
		.optional()
		.describe(
			"also answer a one-time write URL for this slot, for a value that lives in a file or a terminal",
		),
	why: z
		.string()
		.trim()
		.min(3)
		.max(300)
		.describe(
			"what the value is for, in plain words: the person reads it above the field",
		),
	shape: secretShapeSchema
		.optional()
		.describe(
			"the value's shape, so the page asks for it fitly: value (one secret, the default), file, mailbox (address, password, IMAP and SMTP host and port), signin (account, password), or { fields: [{ key, label, secret?, example? }] } written as one JSON object",
		),
	example: z
		.string()
		.trim()
		.min(1)
		.max(120)
		.optional()
		.describe(
			"a made-up example of the value's form (GOCSPX-…, service-account.json), never the value",
		),
});
export type SupportSecretLinkRequest = z.infer<
	typeof supportSecretLinkRequestSchema
>;

/**
 * A person redacting a secret a room kept unscrubbed in a member's message (ISS-1353): the message's
 * text becomes `[Filtered]` on the room's record and its thread's conversation, and the redaction is
 * recorded with who made it and why.
 */
export const supportRedactRequestSchema = z.strictObject({
	reason: z
		.string()
		.trim()
		.min(3)
		.max(500)
		.describe(
			"why the message is redacted, kept on the record of the redaction",
		),
});
export type SupportRedactRequest = z.infer<typeof supportRedactRequestSchema>;

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
	// ISS-1361: the room-ambiguous refusal tells the session to name the thread it was handed
	thread: threadId
		.optional()
		.describe(
			"the thread the message is in, as you were handed it (`thread`): places the read in one group of a channel agent's",
		),
});
/** One line saying why the session answered or stayed silent, kept on its row for the daily review (ISS-942). */
const supportWhySchema = z.string().trim().min(3).max(300);
/**
 * The request a channel agent's reply answers where it was asked in another thread of the same room
 * (ISS-1314): the post goes in the thread that keeps the matter, and that request counts as answered
 * there, so its own thread gets no second post (REQ-77 BC-8, one result per request).
 */
export const supportReplyRequestNamedSchema = z
	.strictObject({
		thread: threadId.describe(
			"the thread the request was asked in, as its message carries `thread`",
		),
		message: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
			.describe("the request's own message id, as it carries `message`"),
	})
	.describe(
		"the request this post answers when it was asked in another thread of this room: post in the thread that keeps the matter, and its own thread gets no second post",
	);
export const supportReplyRequestSchema = z.strictObject({
	thread: threadId,
	text: z.string().trim().min(1).max(4000),
	why: supportWhySchema
		.optional()
		.describe(
			"one line: why this message asked for a reply, kept on the reply's row",
		),
	request: supportReplyRequestNamedSchema.optional(),
});
/**
 * The session posts nothing for a message it was handed, and says why (ISS-942): chatter, a message
 * for someone else, one a Technical member answered, work going on in the background. Recorded on
 * the room and as a line on the thread's conversation; nothing reaches the group.
 */
export const supportSilentRequestSchema = z.strictObject({
	thread: threadId,
	message: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
		.optional()
		.describe(
			"the message you stay silent on, as it carries `message` in what you were handed",
		),
	reason: supportWhySchema.describe("one line: why nothing is posted for it"),
});
/**
 * What a room agent decided for a message it was handed (ISS-1243): to answer it, to gather more on
 * its own first, to ask the person what it still needs, or to stay silent.
 */
export const SUPPORT_ROUTING_DECISIONS = [
	"answer",
	"gather",
	"ask",
	"silent",
] as const;
export type SupportRoutingDecision = (typeof SUPPORT_ROUTING_DECISIONS)[number];

/**
 * What a routing decision rested on (ISS-1243): the message's own words, who sent it, what that
 * sender worked on before, the thread's history and the project its records went to, the room's
 * projects, and a tracker or knowledge search.
 */
export const SUPPORT_ROUTING_SIGNALS = [
	"message",
	"sender",
	"sender_history",
	"thread_history",
	"room_projects",
	"search",
] as const;
export type SupportRoutingSignal = (typeof SUPPORT_ROUTING_SIGNALS)[number];

export const SUPPORT_ROUTING_CONFIDENCES = ["high", "medium", "low"] as const;
export type SupportRoutingConfidence =
	(typeof SUPPORT_ROUTING_CONFIDENCES)[number];

/**
 * The session's routing decision for one message (ISS-1243), kept on the turn that made it: which
 * project the message concerns, what that rested on, how sure, and whether it answers, gathers,
 * asks or stays silent, and why. A silence decided here is the message's stated silence.
 */
export const supportDecideRequestSchema = z.strictObject({
	thread: threadId,
	message: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
		.optional()
		.describe(
			"the message you decide on, as it carries `message` in what you were handed",
		),
	decision: z
		.enum(SUPPORT_ROUTING_DECISIONS)
		.describe(
			"answer it, gather more on your own first, ask the person what you still need (each question with the answer you recommend), or stay silent",
		),
	project: supportProjectSlugSchema
		.optional()
		.describe(
			"the project the message concerns, one you follow by slug; omitted where it concerns none (chatter)",
		),
	signals: z
		.array(z.enum(SUPPORT_ROUTING_SIGNALS))
		.min(1)
		.max(SUPPORT_ROUTING_SIGNALS.length)
		.describe("what the decision rested on"),
	confidence: z
		.enum(SUPPORT_ROUTING_CONFIDENCES)
		.describe("how sure you are of the project and the decision"),
	why: supportWhySchema.describe("one line: why this decision"),
});
export type SupportDecideRequest = z.infer<typeof supportDecideRequestSchema>;
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
	/**
	 * The owner asks for new work in a thread already holding an open item, and approves none of
	 * them (ISS-1243): an approval goes to `approve` instead.
	 */
	separate: z
		.literal(true)
		.optional()
		.describe(
			"true only where the owner asks for new work beside an open item of the thread; his approval of that item is support.approve",
		),
	/**
	 * The pictures that are evidence for the item, each by its message and place (ISS-1327): only these
	 * are attached, never the thread's every picture; none named, none attached.
	 */
	pictures: z
		.array(
			z.strictObject({
				message: z
					.string()
					.min(1)
					.max(64)
					.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id"),
				n: z.number().int().min(1).max(20).optional(),
			}),
		)
		.max(10)
		.optional()
		.describe(
			"the pictures that are evidence, each { message, n? } (n omitted: every picture of that message), each one you looked at with support.image and that shows no secret, password or key",
		),
});

/**
 * The owner's approval, in a thread, of an item recorded from it (ISS-1243): attached to that item
 * as his approval, citing his message, never filed as a new item.
 */
export const supportApproveRequestSchema = z.strictObject({
	thread: threadId,
	message: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
		.describe("the owner's message that approves it"),
	feedback: z
		.string()
		.regex(/^FB-\d+$/, "a Feedback key, FB-n")
		.describe("the open item recorded from this thread that he approves"),
	project: supportProjectSlugSchema
		.optional()
		.describe(
			"the project that item was filed in, where two of the thread's share a key",
		),
});
export type SupportApproveRequest = z.infer<typeof supportApproveRequestSchema>;

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
	message: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
		.describe(
			"the member's message that asked for the move, as it carries `message` in what you were handed: the move runs as its writer",
		),
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

/** A Rocket.Chat message id, as the session was handed it. */
const chatMessageIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id");

/**
 * The owner's consent, or its withdrawal, as the session read it in his own words (ISS-1013, REQ-85
 * BC-3): `message` is the owner's message saying so, in his room; `product` the support API binding
 * it is for, by the name the `tools` list gives it, which may be omitted where the project binds
 * one, and on a withdrawal, which then ends every consent standing in the room.
 */
export const supportOwnerConsentRequestSchema = z.strictObject({
	thread: threadId,
	message: chatMessageIdSchema.describe(
		"the owner's own message saying he agrees, or that the room should stop (`message` in what you were handed)",
	),
	decision: z
		.enum(["give", "withdraw"])
		.describe(
			"give: he agreed to the room acting as him; withdraw: he took it back",
		),
	product: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"the product, by the binding name `tools` lists; omitted where the project binds one, or on a withdrawal meaning all",
		),
});
export type SupportOwnerConsentRequest = z.infer<
	typeof supportOwnerConsentRequestSchema
>;

/** An act in the product as its owner (ISS-1013): an `owner` tool by name, with its arguments. */
export const supportOwnerActRequestSchema = z.strictObject({
	thread: threadId,
	/** The owner's message asking for the act, which the act is logged beside (ISS-1014). */
	message: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
		.describe(
			"the message asking for the act: the id it carries as `message` in what you were handed",
		),
	tool: z.string().min(1).max(48),
	args: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional(),
	/** The owner's plain agreement to an act its product gates on approval (ISS-1014). */
	agreement: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "a Rocket.Chat message id")
		.optional()
		.describe(
			"for a tool listed with approval: the id of the owner's own message agreeing to this act, written in this thread after you asked him",
		),
});
export type SupportOwnerActRequest = z.infer<
	typeof supportOwnerActRequestSchema
>;

/**
 * How the owner gave his consent (REQ-85 BC-3): in his own words in his room (`message`, ISS-1013),
 * or by confirming the sign-in core started for him in the product (`sign_in`, ISS-1047).
 */
export const SUPPORT_OWNER_CONSENT_ROUTES = ["message", "sign_in"] as const;

/**
 * The owner's sign-in to a product, started by core (ISS-1047, REQ-85 BC-3): the session is handed
 * the link to give him in his room; `product` as in `owner_consent`.
 */
export const supportOwnerSignInRequestSchema = z.strictObject({
	thread: threadId,
	product: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"the product, by the binding name `tools` lists; omitted where the project binds one",
		),
});
export type SupportOwnerSignInRequest = z.infer<
	typeof supportOwnerSignInRequestSchema
>;

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
	/** The slug of the project the item was filed in, which for a followed project's record is not the room's (ISS-1243). */
	feedbackProject: string | null;
	/**
	 * The session and turn that took it, where a turn did (ISS-1029): its record is read at
	 * `GET /api/projects/:id/support/rooms/:roomId/turns/:id`.
	 */
	turn: { sessionId: string; id: string } | null;
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

/** How many of a room's threads the rooms read names; `threads` still counts every one. */
export const SUPPORT_ROOM_THREADS_LISTED = 20;

/** One thread of a room as the rooms read names it (ISS-969). */
export interface SupportRoomThreadView {
	/** The thread's id: its opening message's, the `thread` every support act and master post names. */
	thread: string;
	/** Who opened it, by the display name the room shows them; null where no member wrote in it. */
	asker: string | null;
	/** When anything was last recorded in it. */
	lastAt: string;
	/** The feedback items filed from it, FB-n, oldest first. */
	feedback: string[];
}

/** Who set a room's report thread (ISS-1224): a person naming theirs, or Forge opening its own. */
export const SUPPORT_REPORT_THREAD_BY = ["person", "forge"] as const;
export type SupportReportThreadBy = (typeof SUPPORT_REPORT_THREAD_BY)[number];

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
	 * The room's most recent threads, newest first and at most `SUPPORT_ROOM_THREADS_LISTED`, each
	 * with who asked in it and the feedback filed from it (ISS-969): where a master posting a result
	 * into a users' room takes the thread it names.
	 */
	recentThreads: SupportRoomThreadView[];
	/**
	 * This project's own thread in an operations room, as the room's binding records it in
	 * `operations.threads` (ISS-934): where the master's posts and the room's top-level posts land.
	 * Null in any other room, or where none is recorded.
	 */
	projectThread: string | null;
	/**
	 * The room's report thread (ISS-1224): where a master's post naming no thread and core's room-down
	 * line land, never the room's top level. Null until a person names one or Forge opens it.
	 */
	reportThread: string | null;
	/** Who set it: a person naming a thread they wrote in, or Forge opening its own; null with none. */
	reportThreadBy: SupportReportThreadBy | null;
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
	/** An agreed filing could not be recorded; the proposal still stands for the next agree (ISS-1088). */
	"SUPPORT_RECORD_NOT_FILED",
	/** The cited message, or the act, is in another thread than the proposal's (ISS-845). */
	"SUPPORT_AGREEMENT_OTHER_THREAD",
	/** The cited message was written before the proposal was made, so it agrees to nothing (ISS-845). */
	"SUPPORT_AGREEMENT_BEFORE_PROPOSAL",
	"OPS_NOT_AN_OPERATIONS_ROOM",
	"OPS_NO_ROLE",
	"OPS_ROLE_NOT_GRANTED",
	"OPS_OUT_OF_SCOPE",
	"OPS_ASKER_UNMAPPED",
	/** An act runs as the writer of the message it names, which this turn was not handed in that thread (ISS-716). */
	"OPS_ASKER_MESSAGE_UNKNOWN",
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
	/** support.audit's `missed` names a door Forge serves none as (ISS-1251). */
	"SUPPORT_AUDIT_DOOR_UNKNOWN",
	/** A self-audit's `missed` or `redFlag` names a door Forge serves none as (ISS-1251). */
	"SELF_AUDIT_DOOR_UNKNOWN",
	/** A self-audit's failed line names neither or both of a line and a red flag, or a line its role's rubric does not hold (ISS-1251). */
	"SELF_AUDIT_LINE_UNKNOWN",
	/** A self-audit's `redFlag` names a door whose card carries no red flag (ISS-1251). */
	"SELF_AUDIT_NO_RED_FLAG",
	/** A self-audit's `output` names no issue in the project (ISS-1251). */
	"SELF_AUDIT_OUTPUT_UNKNOWN",
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
	/** A channel agent's second reply to one request, or one answering none: one result per request (REQ-77 BC-8, ISS-1314). */
	"SUPPORT_ONE_RESULT_PER_REQUEST",
	/** A channel agent's post says what is live with no release read in its turn (ISS-1123). */
	"SUPPORT_LIVE_CLAIM_UNREAD",
	/** The binding names no owner to ask (REQ-77 BC-12). */
	"SUPPORT_OWNER_NOT_NAMED",
	/** An owner question's `record` names no issue of this project (REQ-77 BC-12). */
	"SUPPORT_OWNER_RECORD_UNKNOWN",
	/** An owner question's `forgeQuestion` names no open question of this project (ISS-871). */
	"SUPPORT_OWNER_QUESTION_UNKNOWN",
	/** The project names no technical channel core can post in: no person for a direct message, or a shared thread where its organization binds no operations room of scope forge (ISS-1243, ISS-1271). */
	"SUPPORT_TECHNICAL_CHANNEL_UNNAMED",
	/** The technical channel could not be posted in: the direct room did not open, or the project's thread of the shared room could not be opened (ISS-1243, ISS-1271). */
	"SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE",
	/** A morning reminder's post names a wait the record settled after the reminder was handed: leave it out (ISS-1343). */
	"SUPPORT_REMINDER_SETTLED",
	/** An act the project keeps from its room agents (`agentDeny`): refused, and raised in the technical channel (ISS-1243). */
	"SUPPORT_ACT_DENIED",
	/** A post telling a work thread the agent lacks a permission or someone must act first (ISS-1243). */
	"SUPPORT_PERMISSION_TALK",
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
	/** The owner's word waiving a switch's duties, given by someone who is not the organization's owner (ISS-945). */
	"AGENT_SWITCH_WAIVER_NOT_OWNER",
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
	/** A read whose declared project secret the vault does not hold (ISS-707). */
	"SUPPORT_READ_SECRET_MISSING",
	/** A read's argument outside its parameter's pattern, enum or length, unknown, or missing (ISS-871). */
	"SUPPORT_READ_ARGS",
	/** The box could not run a declared read (ISS-871). */
	"SUPPORT_READ_FAILED",
	/** A post holds an internal code outside a team member's own thread (ISS-872, ISS-873). */
	"SUPPORT_INTERNAL_CODE",
	/** A master's top-level post into a room the product's users read (ISS-872). */
	"SUPPORT_MASTER_POST_USERS_ROOM",
	/** A master's post into a users' thread already told a recorded item's result, naming no follow-up of it (ISS-969, FB-498). */
	"SUPPORT_MASTER_POST_ALREADY_TOLD",
	/** A master's post into a room its project held once, whose binding is switched off or no longer names it (ISS-943). */
	"SUPPORT_ROOM_SWITCHED_OFF",
	/** A master's post into a thread whose first message the chat server places in another room than the one named (ISS-943). */
	"SUPPORT_THREAD_OF_ANOTHER_ROOM",
	/** A master's post into an operations room shared by projects, with no thread recorded for its project (ISS-934). */
	"SUPPORT_PROJECT_THREAD_UNRECORDED",
	/** A master's post naming no thread, where the room's report thread could not be opened (ISS-1224). */
	"SUPPORT_POST_NEEDS_THREAD",
	/** A thread that names no parked question handed to this group (ISS-873). */
	"SUPPORT_QUESTION_UNKNOWN",
	/** An answer naming neither or both of where it is: the record, or the owner's message (ISS-873). */
	"SUPPORT_ANSWER_SOURCE",
	/** A message the owner did not write in this group, cited as their answer (ISS-873). */
	"SUPPORT_ANSWER_NOT_THE_OWNER",
	/** The question was already asked and waits in the technical channel (ISS-873, ISS-1246). */
	"SUPPORT_OWNER_ALREADY_ASKED",
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
	/** A picture a record names that no member message of its thread carries (ISS-1327). */
	"SUPPORT_PICTURE_UNKNOWN",
	/** A picture a record names from a message whose text had a secret filtered (ISS-1327). */
	"SUPPORT_PICTURE_HELD_SECRET",
	/** A secret link naming a testing profile the project does not declare (ISS-1328). */
	"SUPPORT_SECRET_PROFILE_UNKNOWN",
	/** A secret link naming neither or both of an actor and a service (ISS-1328). */
	"SUPPORT_SECRET_SLOT_ONE",
	/** A secret link carrying a field its kind does not take, or missing one it does (ISS-1348). */
	"SUPPORT_SECRET_SLOT_SHAPE",
	/** A variable secret link naming an environment the project does not declare (ISS-1348). */
	"SUPPORT_SECRET_ENVIRONMENT_UNKNOWN",
	/** An integration secret link naming a provider the project binds no connection of (ISS-1348). */
	"SUPPORT_SECRET_INTEGRATION_UNKNOWN",
	/** An integration secret link naming a provider the project binds through several connections (ISS-1348). */
	"SUPPORT_SECRET_INTEGRATION_AMBIGUOUS",
	/** An integration whose credential is not typed by hand (an App installed, a key minted) (ISS-1348). */
	"SUPPORT_SECRET_INTEGRATION_NOT_BY_HAND",
	/** A write URL whose token names no ask (ISS-1348). */
	"SUPPORT_SECRET_WRITE_UNKNOWN",
	/** A write URL already used once (ISS-1348). */
	"SUPPORT_SECRET_WRITE_USED",
	/** A write URL past its time (ISS-1348). */
	"SUPPORT_SECRET_WRITE_EXPIRED",
	/** A write URL asked to answer anything but a PUT: it writes, and reads nothing (ISS-1348). */
	"SUPPORT_SECRET_WRITE_ONLY",
	/** A write URL PUT with no value in its body (ISS-1348). */
	"SUPPORT_SECRET_WRITE_EMPTY",
	/** A write URL PUT with a body longer than a secret holds (ISS-1348). */
	"SUPPORT_SECRET_WRITE_TOO_LONG",
	/** A secret ask whose asking line or example holds what reads as a secret itself (ISS-1348). */
	"SUPPORT_SECRET_ASK_HOLDS_SECRET",
	/** A one-time write URL asked of a request already filled (ISS-1348). */
	"SUPPORT_SECRET_ASK_FILLED",
	/** A request of the Secrets page naming no ask of the project (ISS-1348). */
	"SUPPORT_SECRET_ASK_UNKNOWN",
	/** A one-time write URL asked by an agent credential: a person mints one on the page (ISS-1348). */
	"SUPPORT_SECRET_ASK_PERSON_ONLY",
	/** A secret link naming an actor or service its profile does not declare (ISS-1328). */
	"SUPPORT_SECRET_SLOT_UNKNOWN",
	/** A testing secret link naming a service whose credential is a stored variable: a variable link (ISS-1328). */
	"SUPPORT_SECRET_SLOT_VARIABLE",
	/** A secret link asked of a core that knows no web app address to link to (ISS-1328). */
	"SUPPORT_SECRET_LINK_NO_WEB",
	/** The chat server could not be read for the picture (ISS-1010). */
	"SUPPORT_IMAGE_UNREACHABLE",
	/** A master's post names an image no issue, comment or session upload has (ISS-1024). */
	"SUPPORT_POST_IMAGE_UNKNOWN",
	/** A master's post names an upload of a project its caller cannot read (ISS-1024). */
	"SUPPORT_POST_IMAGE_UNREADABLE",
	/** A master's post names an upload that is no png, jpeg, gif, webp or PDF (ISS-1024, ISS-1238). */
	"SUPPORT_POST_IMAGE_NOT_AN_IMAGE",
	/** A master's post names an image or a PDF larger than a room's cap for it (ISS-1024, ISS-1238). */
	"SUPPORT_POST_IMAGE_TOO_LARGE",
	/** A master's post names an upload whose file is gone from storage (ISS-1024). */
	"SUPPORT_POST_IMAGE_FILE_MISSING",
	/** The chat server took no image of a master's post (ISS-1024). */
	"SUPPORT_POST_IMAGE_UNPOSTED",
	/** An edit or delete naming no room message a master posted through master-posts (ISS-1238). */
	"SUPPORT_POST_UNKNOWN",
	/** An edit or delete of a room message that is not this master's own master-post (ISS-1238). */
	"SUPPORT_POST_NOT_YOURS",
	/** An edit or delete of a master's post after its edit window (ISS-1238). */
	"SUPPORT_POST_EDIT_WINDOW_PASSED",
	/** An edit or delete of a master's post already deleted (ISS-1238). */
	"SUPPORT_POST_DELETED",
	/** The chat server would not edit or delete a master's post (ISS-1238). */
	"SUPPORT_POST_UNCHANGED",
	/** A master's post was deleted, and the chat server kept one of its image or PDF messages (ISS-1238). */
	"SUPPORT_POST_FILES_LEFT",
	/** A promise naming an issue of a project the room does not follow (ISS-1012). */
	"SUPPORT_PROMISE_NOT_FOLLOWED",
	/** A promise naming no issue of the project its key or `project` names (ISS-1012). */
	"SUPPORT_PROMISE_ISSUE_UNKNOWN",
	/** A promise about an issue already dropped, which will never reach any environment (ISS-1012). */
	"SUPPORT_PROMISE_ISSUE_DROPPED",
	/** A promise naming a key whose prefix is not one the project numbers its issues with (ISS-1275). */
	"SUPPORT_PROMISE_KEY_FOREIGN",
	/** A promise naming a feedback item, which is no issue: its carrying issue, or that it has none yet (ISS-1275). */
	"SUPPORT_PROMISE_FEEDBACK_NOT_ISSUE",
	/** A promise naming an environment the project does not declare, or whose serving Forge cannot read (ISS-1012). */
	"SUPPORT_PROMISE_ENVIRONMENT_UNTRACKED",
	/** An owner act, or his consent, outside the owner's own room (ISS-1013). */
	"SUPPORT_OWNER_OTHER_ROOM",
	/** An owner act in a product the owner has not consented to, or has withdrawn from (ISS-1013). */
	"SUPPORT_OWNER_NO_CONSENT",
	/** A consent cited from a message the owner did not write (ISS-1013). */
	"SUPPORT_CONSENT_NOT_THE_OWNER",
	/** An owner act its product gates on approval, with no agreement of his cited after he was asked (ISS-1014). */
	"SUPPORT_OWNER_APPROVAL_NEEDED",
	/** An owner act's agreement cited from a message the owner did not write (ISS-1014). */
	"SUPPORT_OWNER_APPROVAL_NOT_HIS",
	/** An approval cited from a message that is not the owner's own in the thread named (ISS-1243). */
	"SUPPORT_APPROVAL_NOT_THE_OWNERS",
	/** An approval naming no open item recorded from its thread (ISS-1243). */
	"SUPPORT_APPROVAL_ITEM_UNKNOWN",
	/** A record the owner asks for in a thread holding an open item, naming neither that it approves one nor that it is separate (ISS-1243). */
	"SUPPORT_RECORD_IS_APPROVAL",
	/** A release decision cited from a message that is no member's own in the thread named (ISS-1206). */
	"SUPPORT_RELEASE_DECISION_NOT_HIS_MESSAGE",
	/** A release decision whose writer holds no releases.approve on the release's project (ISS-1206). */
	"SUPPORT_RELEASE_DECISION_NOT_PERMITTED",
	/** A release decision naming no one whole version (ISS-1206). */
	"SUPPORT_RELEASE_VERSION_AMBIGUOUS",
	/** An owner's Forge act cited from a message that is no member's own in the thread named (ISS-1243). */
	"SUPPORT_FORGE_ACT_NOT_HIS_MESSAGE",
	/** An owner's Forge act cited from a message the room's named owner did not write, as the chat server signed it (ISS-1243). */
	"SUPPORT_FORGE_ACT_NOT_THE_OWNER",
	/** An owner's Forge act in a room whose binding names no owner (ISS-1243). */
	"SUPPORT_FORGE_ACT_NO_OWNER",
	/** An owner's Forge act carrying a field another act takes, or missing the document it writes (ISS-1243). */
	"SUPPORT_FORGE_ACT_SHAPE",
	/** An act the owner asks for that Forge makes as him from chat through no door (ISS-1243). */
	"SUPPORT_FORGE_ACT_NO_CONSENT_PATH",
	/** An act the owner's Needs you can owe that no door from chat makes yet, naming the page that makes it (ISS-1299). */
	"SUPPORT_FORGE_ACT_NO_DOOR",
	/** A raise into a technical thread where a person spoke within the turn, naming no answer to his message (ISS-1299). */
	"SUPPORT_RAISE_THREAD_UNREAD",
	/** A raise whose words are not in the language the technical thread's reader writes (ISS-1299). */
	"SUPPORT_RAISE_NOT_IN_THREAD_LANGUAGE",
	/** A consent naming no product the project binds, or none where it binds several (ISS-1013). */
	"SUPPORT_OWNER_PRODUCT_UNKNOWN",
	/** No owner credential kept for the product, or one that cannot be used (ISS-1013). */
	"SUPPORT_OWNER_CREDENTIAL_MISSING",
	/** The owner's credential ended (its refresh refused, or expired with none): he signs in again (ISS-1047). */
	"SUPPORT_OWNER_SIGN_IN_AGAIN",
	/** The binding declares no `ownerSignIn`, or one core cannot use, so no sign-in or refresh is made (ISS-1047). */
	"SUPPORT_OWNER_SIGN_IN_UNDECLARED",
	/** The product's token endpoint gave no answer, and the access token is spent; nothing was sent (ISS-1047). */
	"SUPPORT_OWNER_TOKEN_UNANSWERED",
	/** The binding names no owner account, or no way to read who signed in, so no sign-in is started (ISS-1052). */
	"SUPPORT_OWNER_IDENTITY_UNDECLARED",
	/** Someone other than the owner's own account completed his sign-in: nothing was kept (ISS-1052). */
	"SUPPORT_OWNER_SIGN_IN_NOT_THE_OWNER",
	/** A direct message to a room's session from someone below project admin: nothing ran (ISS-950). */
	"SUPPORT_DIRECT_TURN_NEEDS_ADMIN",
	/** A direct message to a room's session carrying what a room turn cannot: files, a picked box (ISS-950). */
	"SUPPORT_DIRECT_TURN_SHAPE",
	/** A turn no action of the room names (ISS-1029). */
	"SUPPORT_TURN_UNKNOWN",
	/** A master's answer naming no ask of a room agent to this project's master (ISS-1243). */
	"SUPPORT_MASTER_ASK_UNKNOWN",
	/** A master's answer to a room agent's ask that was already answered (ISS-1243). */
	"SUPPORT_MASTER_ASK_ANSWERED",
	/** A raise naming no thread an item owed to the owner was handed in (ISS-1243). */
	"SUPPORT_OWED_UNKNOWN",
	/** An item owed to the owner raised a second time (ISS-1243). */
	"SUPPORT_OWED_ALREADY_RAISED",
	/** A citation naming no active reference source of the project (ISS-1252). */
	"SUPPORT_REFERENCE_UNKNOWN",
	/** A redaction naming no member message of the room (ISS-1353). */
	"SUPPORT_ACTION_UNKNOWN",
	/** A redaction of a member message already redacted (ISS-1353). */
	"SUPPORT_ACTION_REDACTED",
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
	OPS_ASKER_MESSAGE_UNKNOWN: 409,
	OPS_ISSUE_UNKNOWN: 404,
	SUPPORT_ABILITY_NOT_GRANTED: 403,
	SUPPORT_NOT_A_CONFIRMER: 403,
	SUPPORT_COMMAND_FAILED: 503,
	SUPPORT_BUILD_REFUSED: 409,
	SUPPORT_MEMBER_CONFIRMED: 409,
	SUPPORT_MENTION_REFUSED: 409,
	SUPPORT_CHANNEL_PRIVATE_DATA: 400,
	SUPPORT_MESSAGE_UNKNOWN: 404,
	SUPPORT_AUDIT_DOOR_UNKNOWN: 400,
	SELF_AUDIT_DOOR_UNKNOWN: 400,
	SELF_AUDIT_LINE_UNKNOWN: 400,
	SELF_AUDIT_NO_RED_FLAG: 400,
	SELF_AUDIT_OUTPUT_UNKNOWN: 404,
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
	SUPPORT_LIVE_CLAIM_UNREAD: 409,
	SUPPORT_OWNER_NOT_NAMED: 409,
	SUPPORT_OWNER_RECORD_UNKNOWN: 404,
	SUPPORT_OWNER_QUESTION_UNKNOWN: 404,
	SUPPORT_TECHNICAL_CHANNEL_UNNAMED: 409,
	SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE: 503,
	SUPPORT_REMINDER_SETTLED: 409,
	SUPPORT_ACT_DENIED: 403,
	SUPPORT_PERMISSION_TALK: 400,
	SUPPORT_GIT_NOT_OWNER_MODE: 403,
	SUPPORT_GIT_NOT_OWN_REPO: 403,
	SUPPORT_CHECK_UNKNOWN: 404,
	SUPPORT_CHECK_ANSWERED: 409,
	SUPPORT_REFERENCE_UNKNOWN: 404,
	AGENT_SWITCH_UNKNOWN: 404,
	AGENT_SWITCH_NOT_READY: 409,
	AGENT_SWITCH_DONE: 409,
	AGENT_SWITCH_NOT_SWITCHED: 409,
	AGENT_SWITCH_PLAN_REFUSED: 400,
	AGENT_SWITCH_BOT_NOT_REMOVED: 503,
	AGENT_SWITCH_NO_AGENT: 409,
	AGENT_SWITCH_DUTY_NAMES_BOX: 400,
	AGENT_SWITCH_WAIVER_NOT_OWNER: 403,
	AGENT_SWITCH_OUTSIDE_RUNNING: 409,
	AGENT_SWITCH_OUTSIDE_NOT_SELF: 409,
	SUPPORT_DEPLOYMENT_UNREADABLE: 503,
	SUPPORT_NOT_A_CHANNEL_AGENT: 409,
	SUPPORT_READ_UNDECLARED: 404,
	SUPPORT_READ_SECRET_MISSING: 409,
	SUPPORT_READ_ARGS: 400,
	SUPPORT_READ_FAILED: 503,
	SUPPORT_INTERNAL_CODE: 400,
	SUPPORT_MASTER_POST_USERS_ROOM: 409,
	SUPPORT_MASTER_POST_ALREADY_TOLD: 409,
	SUPPORT_ROOM_SWITCHED_OFF: 409,
	SUPPORT_THREAD_OF_ANOTHER_ROOM: 409,
	SUPPORT_PROJECT_THREAD_UNRECORDED: 409,
	SUPPORT_POST_NEEDS_THREAD: 503,
	SUPPORT_QUESTION_UNKNOWN: 404,
	SUPPORT_ANSWER_SOURCE: 400,
	SUPPORT_ANSWER_NOT_THE_OWNER: 409,
	SUPPORT_OWNER_ALREADY_ASKED: 409,
	SUPPORT_IMAGE_UNKNOWN: 404,
	SUPPORT_IMAGE_TOO_LARGE: 409,
	SUPPORT_IMAGE_GONE: 404,
	SUPPORT_IMAGE_REFUSED: 503,
	SUPPORT_IMAGE_OFF_SERVER: 409,
	SUPPORT_PICTURE_UNKNOWN: 404,
	SUPPORT_PICTURE_HELD_SECRET: 409,
	SUPPORT_SECRET_PROFILE_UNKNOWN: 404,
	SUPPORT_SECRET_SLOT_ONE: 400,
	SUPPORT_SECRET_SLOT_SHAPE: 400,
	SUPPORT_SECRET_ENVIRONMENT_UNKNOWN: 404,
	SUPPORT_SECRET_INTEGRATION_UNKNOWN: 404,
	SUPPORT_SECRET_INTEGRATION_AMBIGUOUS: 409,
	SUPPORT_SECRET_INTEGRATION_NOT_BY_HAND: 409,
	SUPPORT_SECRET_WRITE_UNKNOWN: 404,
	SUPPORT_SECRET_WRITE_USED: 409,
	SUPPORT_SECRET_WRITE_EXPIRED: 409,
	SUPPORT_SECRET_WRITE_ONLY: 403,
	SUPPORT_SECRET_WRITE_EMPTY: 400,
	SUPPORT_SECRET_WRITE_TOO_LONG: 400,
	SUPPORT_SECRET_ASK_HOLDS_SECRET: 400,
	SUPPORT_SECRET_ASK_FILLED: 409,
	SUPPORT_SECRET_ASK_UNKNOWN: 404,
	SUPPORT_SECRET_ASK_PERSON_ONLY: 403,
	SUPPORT_SECRET_SLOT_UNKNOWN: 404,
	SUPPORT_SECRET_SLOT_VARIABLE: 409,
	SUPPORT_SECRET_LINK_NO_WEB: 503,
	SUPPORT_IMAGE_UNREACHABLE: 503,
	SUPPORT_POST_IMAGE_UNKNOWN: 404,
	SUPPORT_POST_IMAGE_UNREADABLE: 403,
	SUPPORT_POST_IMAGE_NOT_AN_IMAGE: 400,
	SUPPORT_POST_IMAGE_TOO_LARGE: 400,
	SUPPORT_POST_IMAGE_FILE_MISSING: 404,
	SUPPORT_POST_IMAGE_UNPOSTED: 503,
	SUPPORT_POST_UNKNOWN: 404,
	SUPPORT_POST_NOT_YOURS: 403,
	SUPPORT_POST_EDIT_WINDOW_PASSED: 409,
	SUPPORT_POST_DELETED: 409,
	SUPPORT_POST_UNCHANGED: 503,
	SUPPORT_POST_FILES_LEFT: 503,
	SUPPORT_PROMISE_NOT_FOLLOWED: 403,
	SUPPORT_PROMISE_ISSUE_UNKNOWN: 404,
	SUPPORT_PROMISE_ISSUE_DROPPED: 409,
	SUPPORT_PROMISE_KEY_FOREIGN: 400,
	SUPPORT_PROMISE_FEEDBACK_NOT_ISSUE: 409,
	SUPPORT_PROMISE_ENVIRONMENT_UNTRACKED: 409,
	SUPPORT_OWNER_OTHER_ROOM: 403,
	SUPPORT_OWNER_NO_CONSENT: 403,
	SUPPORT_CONSENT_NOT_THE_OWNER: 403,
	SUPPORT_OWNER_APPROVAL_NEEDED: 409,
	SUPPORT_OWNER_APPROVAL_NOT_HIS: 403,
	SUPPORT_APPROVAL_NOT_THE_OWNERS: 403,
	SUPPORT_APPROVAL_ITEM_UNKNOWN: 404,
	SUPPORT_RECORD_IS_APPROVAL: 409,
	SUPPORT_RELEASE_DECISION_NOT_HIS_MESSAGE: 403,
	SUPPORT_RELEASE_DECISION_NOT_PERMITTED: 403,
	SUPPORT_RELEASE_VERSION_AMBIGUOUS: 400,
	SUPPORT_FORGE_ACT_NOT_HIS_MESSAGE: 403,
	SUPPORT_FORGE_ACT_NOT_THE_OWNER: 403,
	SUPPORT_FORGE_ACT_NO_OWNER: 403,
	SUPPORT_FORGE_ACT_SHAPE: 400,
	SUPPORT_FORGE_ACT_NO_CONSENT_PATH: 409,
	SUPPORT_FORGE_ACT_NO_DOOR: 409,
	SUPPORT_RAISE_THREAD_UNREAD: 409,
	SUPPORT_RAISE_NOT_IN_THREAD_LANGUAGE: 400,
	SUPPORT_OWNER_PRODUCT_UNKNOWN: 404,
	SUPPORT_OWNER_CREDENTIAL_MISSING: 409,
	SUPPORT_DIRECT_TURN_NEEDS_ADMIN: 403,
	SUPPORT_DIRECT_TURN_SHAPE: 400,
	SUPPORT_TURN_UNKNOWN: 404,
	SUPPORT_MASTER_ASK_UNKNOWN: 404,
	SUPPORT_MASTER_ASK_ANSWERED: 409,
	SUPPORT_OWED_UNKNOWN: 404,
	SUPPORT_OWED_ALREADY_RAISED: 409,
	SUPPORT_ACTION_UNKNOWN: 404,
	SUPPORT_ACTION_REDACTED: 409,
} as const satisfies RefusalStatuses<SupportRefusalCode>;
