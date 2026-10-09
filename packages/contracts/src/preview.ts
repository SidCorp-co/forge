// A live preview (REQ-39 "See a change live before it ships"; docs/proposals/live-preview.md): the
// dev server a run starts in its worktree, served to the project's members from a Forge link while
// the change is being made. Core decides who may view it and for how long; the runner only starts
// the dev server and carries its bytes (`./preview-tunnel.ts`). This module is the record, its
// machine, why one fails, the refusals, the project setting and how the setting is read from the
// repository when unset.

import { z } from "zod";
import { wholeShaSchema } from "./check-runs.js";
import { LANES } from "./fast-lane.js";
import { REASON_PARAGRAPH_MAX } from "./reason-text.js";
import type { RefusalStatuses } from "./refusal.js";
import { defineMachine, fromEach } from "./state-machine.js";

/**
 * `starting`: the runner was asked to start the dev server. `live`: it answers on its port and the
 * link serves it. `idle_closed`: nobody viewed it for the project's idle setting, so the dev server
 * was stopped; reopening starts it again in the same worktree at the same link. `approved`: a
 * person approved what it shows and the change goes down its lane. `abandoned`: closed by a person,
 * or because the run holding the worktree ended. `failed`: it could not start or stopped answering,
 * with a `PreviewFailureReason`.
 */
export const PREVIEW_STATES = [
	"starting",
	"live",
	"idle_closed",
	"approved",
	"abandoned",
	"failed",
] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

/** The states whose link serves (or is about to): every other state answers the closed page. */
export const PREVIEW_SERVING_STATES = [
	"starting",
	"live",
] as const satisfies readonly PreviewState[];

/**
 * Why a preview failed, shown on the issue (BC-10). The first three are the criterion's own words;
 * the rest are the other ways the same promise breaks, each named rather than folded into one.
 */
export const PREVIEW_FAILURE_REASONS = [
	/** No `preview.command` is set and none could be read from the repository. */
	"NO_START_COMMAND",
	/** The repository names a dev command but not the port it listens on, and none is set. */
	"PORT_UNDECLARED",
	/** The fixed port the setting names is held by another process on the box. */
	"PORT_IN_USE",
	/** The dev server exited; `detail` holds its exit status and the tail of its output. */
	"DEV_SERVER_EXITED",
	/** The dev server kept running but never answered on its port within the ready timeout. */
	"DEV_SERVER_NOT_LISTENING",
	/**
	 * The dev server answered on an address other than loopback, where anyone who can reach the box
	 * could open it without Forge (BC-5); the box stopped it. `detail` names the address.
	 */
	"DEV_SERVER_EXPOSED",
	/** The box's tunnel dropped and did not return within the grace period. */
	"RUNNER_OFFLINE",
	/** The box's runner predates previews and does not declare the capability. */
	"RUNNER_CANNOT_PREVIEW",
	/** The run's worktree is gone, so there is nothing to serve. */
	"WORKTREE_GONE",
	/** The setting names an environment whose tier is production (BC-13). */
	"PRODUCTION_ENVIRONMENT",
] as const;
export type PreviewFailureReason = (typeof PREVIEW_FAILURE_REASONS)[number];

/**
 * The preview's moves. Only the kernel reports a dev server up, down or idle (`permission: null`);
 * a person reopens, abandons and approves. The approve permission is `previews.approve`, which the
 * preview-tunnel lane adds to `./permissions.ts:APPROVAL_RESOURCES` (admin's by default, a member's
 * where the project grants it). Registered in `./machines.ts` by that lane with its table.
 */
export const PREVIEW_MACHINE = defineMachine({
	entity: "preview",
	shapes: ["c8c6c35b"],
	design: null,
	states: PREVIEW_STATES,
	initial: ["starting"],
	terminal: ["approved", "abandoned", "failed"],
	reasonRequired: ["abandoned", "failed"],
	edges: [
		{
			from: "starting",
			to: "live",
			act: "preview.live",
			permission: null,
			guards: [],
		},
		{
			from: "starting",
			to: "failed",
			act: "preview.failed",
			permission: null,
			guards: [],
		},
		{
			from: "live",
			to: "failed",
			act: "preview.failed",
			permission: null,
			guards: [],
		},
		{
			from: "live",
			to: "idle_closed",
			act: "preview.idleClosed",
			permission: null,
			guards: [],
		},
		{
			from: "idle_closed",
			to: "starting",
			act: "preview.reopened",
			permission: "project.write",
			guards: [],
		},
		...fromEach<PreviewState>(["live", "idle_closed"], "approved", {
			act: "preview.approved",
			permission: "previews.approve",
			guards: [],
		}),
		...fromEach<PreviewState>(
			["starting", "live", "idle_closed"],
			"abandoned",
			{
				act: "preview.abandoned",
				permission: "project.write",
				guards: [],
			},
		),
	],
});

export const PREVIEW_LIMITS = {
	/** The setting's command, as typed. */
	command: 300,
	/** A path inside the repository the command runs in. */
	cwd: 200,
	idleMinutes: { min: 5, max: 240, default: 30 },
	/** How long a started dev server has to answer on its port before it is DEV_SERVER_NOT_LISTENING. */
	readyTimeoutSeconds: 120,
	/** How long a dropped tunnel may stay away before its live previews are RUNNER_OFFLINE. */
	tunnelGraceSeconds: 60,
	/** The tail of the dev server's output a failure keeps, in characters. */
	detail: 2000,
	/** A `package.json` the runner reports for detection, in bytes. */
	packageJson: 65_536,
	/** A chat message sent into a preview's run (BC-6). */
	message: 4000,
	/** The one-time ticket that lets a browser in (a minute, as Coder's smuggled key). */
	ticketSeconds: 60,
	/** How long a viewer's preview cookie lives before the ticket dance runs again. */
	viewerSeconds: 8 * 60 * 60,
	/** A preview never listens below this port, and never on a port the setting does not name. */
	port: { min: 1024, max: 65_535 },
} as const;

/** The placeholder a command holds when the runner picks a free port for it. */
export const PREVIEW_PORT_PLACEHOLDER = "{port}";

/** The host label a preview is served at: `p-` and 16 lower-case base32 characters (80 random bits). */
export const PREVIEW_HOST_LABEL = /^p-[a-z2-7]{16}$/;

/**
 * Paths under this prefix on a preview host are Forge's own (the ticket exchange, the closed page)
 * and never reach the dev server.
 */
export const PREVIEW_RESERVED_PATH = "/__forge_preview/";
export const PREVIEW_ENTER_PATH = `${PREVIEW_RESERVED_PATH}enter`;

/**
 * The viewer cookie: host-only on the preview host, `Secure; HttpOnly; SameSite=None; Partitioned`
 * so it holds inside Forge's iframe. The relay removes it from every request before the dev server
 * sees one. Forge's own session cookies never arrive at all: the preview domain is another site,
 * which is the whole isolation (Coder's subdomain apps, `coderd/workspaceapps/proxy.go`), so the
 * project's own cookies, whatever their names, pass through untouched.
 */
export const PREVIEW_COOKIE = "forge_preview";

/** The preview a `Host` header names, or null where it names none: one label under the preview domain. */
export function previewLabelOf(
	host: string,
	previewDomain: string,
): string | null {
	const name = host.toLowerCase().replace(/:\d+$/, "");
	const suffix = `.${previewDomain.toLowerCase()}`;
	if (!name.endsWith(suffix)) return null;
	const label = name.slice(0, -suffix.length);
	return PREVIEW_HOST_LABEL.test(label) ? label : null;
}

export const previewUrl = (label: string, previewDomain: string) =>
	`https://${label}.${previewDomain}/`;

const relativeDir = z
	.string()
	.trim()
	.max(PREVIEW_LIMITS.cwd)
	.refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
		error:
			"preview.cwd is a directory inside the repository: relative, with no `..`",
	});

/**
 * How a project's preview starts (BC-11), a key of the project document. `command` runs in `cwd`
 * of the run's worktree. Where it holds `{port}` the runner picks a free loopback port and passes it
 * there and as `PORT`; otherwise `port` names the one it listens on. `environment` names the
 * project environment whose variables the dev server gets, never one whose tier is production
 * (BC-13, refused PREVIEW_PRODUCTION_ENVIRONMENT by core, which holds the tiers).
 */
export const previewSettingsSchema = z
	.strictObject({
		command: z.string().trim().min(1).max(PREVIEW_LIMITS.command),
		port: z
			.int()
			.min(PREVIEW_LIMITS.port.min)
			.max(PREVIEW_LIMITS.port.max)
			.optional(),
		cwd: relativeDir.optional(),
		idleMinutes: z
			.int()
			.min(PREVIEW_LIMITS.idleMinutes.min)
			.max(PREVIEW_LIMITS.idleMinutes.max)
			.optional(),
		environment: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]*$/)
			.max(60)
			.optional(),
	})
	.superRefine((s, ctx) => {
		const placeholder = s.command.includes(PREVIEW_PORT_PLACEHOLDER);
		if (placeholder && s.port !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["port"],
				message: `preview.port is set and the command holds ${PREVIEW_PORT_PLACEHOLDER}: name one port, either a fixed one or the placeholder the runner fills`,
			});
		}
		if (!placeholder && s.port === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["port"],
				message: `preview.port is required when the command does not hold ${PREVIEW_PORT_PLACEHOLDER}: the preview has to know where the dev server listens`,
			});
		}
	});
export type PreviewSettings = z.infer<typeof previewSettingsSchema>;

/** What the runner reads from the worktree for detection; core decides (thin box agent, ADR 0009). */
export const repositoryFactsSchema = z.strictObject({
	cwd: z.string().max(PREVIEW_LIMITS.cwd),
	/** The raw text of `<cwd>/package.json`, or null where there is none. */
	packageJson: z.string().max(PREVIEW_LIMITS.packageJson).nullable(),
	/** The lockfile names present at the repository root. */
	lockfiles: z.array(z.string().max(60)).max(10),
});
export type RepositoryFacts = z.infer<typeof repositoryFactsSchema>;

/** Dev servers whose port flag is known, first match wins; each takes `--port`. */
const KNOWN_DEV_SERVERS = [
	{ framework: "next", dependency: "next" },
	{ framework: "nuxt", dependency: "nuxt" },
	{ framework: "astro", dependency: "astro" },
	{ framework: "sveltekit", dependency: "@sveltejs/kit" },
	{ framework: "vite", dependency: "vite" },
] as const;

const PACKAGE_MANAGERS = [
	{ name: "pnpm", lockfile: "pnpm-lock.yaml", run: "pnpm run dev", pass: "" },
	{ name: "yarn", lockfile: "yarn.lock", run: "yarn run dev", pass: "" },
	{ name: "bun", lockfile: "bun.lock", run: "bun run dev", pass: "" },
	{ name: "bun", lockfile: "bun.lockb", run: "bun run dev", pass: "" },
	{
		name: "npm",
		lockfile: "package-lock.json",
		run: "npm run dev",
		pass: "-- ",
	},
] as const;

export type PreviewDetection =
	| {
			ok: true;
			settings: PreviewSettings;
			framework: string;
			packageManager: string;
	  }
	| {
			ok: false;
			reason: "NO_START_COMMAND" | "PORT_UNDECLARED";
			detail: string;
	  };

/**
 * Reads the preview setting from the repository when the project has none (BC-11): the `dev` script
 * of `package.json`, run with the package manager its `packageManager` field or lockfile names. A
 * known dev server gets `--port {port}`; a script that fixes its own port keeps it; anything else is
 * refused by name, never guessed.
 */
/**
 * The flag that keeps a dev server on loopback where its framework binds every address by default:
 * `next dev` listens on 0.0.0.0 unless given `--hostname`, and reads no variable for it, so the box's
 * `HOST=127.0.0.1` does not reach it (BC-5). Empty where the script names its own host or binds
 * loopback already.
 */
function loopbackFlagOf(dev: string): string {
	if (!/\bnext\s+dev\b/.test(dev)) return "";
	if (/(?:^|\s)(?:-H|--hostname)(?:[ =]|$)/.test(dev)) return "";
	return "--hostname 127.0.0.1";
}

export function detectPreviewSettings(
	facts: RepositoryFacts,
): PreviewDetection {
	const where = facts.cwd === "" ? "package.json" : `${facts.cwd}/package.json`;
	if (facts.packageJson === null) {
		return {
			ok: false,
			reason: "NO_START_COMMAND",
			detail: `${where} does not exist; set preview.command`,
		};
	}
	let pkg: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(facts.packageJson);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error("not an object");
		pkg = parsed as Record<string, unknown>;
	} catch {
		return {
			ok: false,
			reason: "NO_START_COMMAND",
			detail: `${where} is not a JSON object; set preview.command`,
		};
	}
	const scripts = record(pkg.scripts);
	const dev = scripts.dev;
	if (typeof dev !== "string" || dev.trim() === "") {
		return {
			ok: false,
			reason: "NO_START_COMMAND",
			detail: `${where} has no "dev" script; set preview.command`,
		};
	}
	const manager = packageManagerOf(pkg, facts.lockfiles);
	const base = { ...(facts.cwd === "" ? {} : { cwd: facts.cwd }) };
	const fixed = /(?:--port[ =]|-p )(\d{2,5})\b/.exec(dev);
	const loopback = loopbackFlagOf(dev);
	if (fixed?.[1] !== undefined) {
		return {
			ok: true,
			settings: {
				command: `${manager.run}${loopback === "" ? "" : ` ${manager.pass}${loopback}`}`,
				port: Number(fixed[1]),
				...base,
			},
			framework: frameworkOf(pkg) ?? "unknown",
			packageManager: manager.name,
		};
	}
	const framework = frameworkOf(pkg);
	if (framework === null) {
		return {
			ok: false,
			reason: "PORT_UNDECLARED",
			detail: `${where} "dev" runs "${dev}", whose port Forge cannot tell; set preview.port or a command holding ${PREVIEW_PORT_PLACEHOLDER}`,
		};
	}
	return {
		ok: true,
		settings: {
			command: `${manager.run} ${manager.pass}--port ${PREVIEW_PORT_PLACEHOLDER}${loopback === "" ? "" : ` ${loopback}`}`,
			...base,
		},
		framework,
		packageManager: manager.name,
	};
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function frameworkOf(pkg: Record<string, unknown>): string | null {
	const deps = { ...record(pkg.devDependencies), ...record(pkg.dependencies) };
	return (
		KNOWN_DEV_SERVERS.find((s) => Object.hasOwn(deps, s.dependency))
			?.framework ?? null
	);
}

function packageManagerOf(
	pkg: Record<string, unknown>,
	lockfiles: readonly string[],
) {
	const declared =
		typeof pkg.packageManager === "string"
			? pkg.packageManager.split("@")[0]
			: undefined;
	const npm = PACKAGE_MANAGERS[
		PACKAGE_MANAGERS.length - 1
	] as (typeof PACKAGE_MANAGERS)[number];
	return (
		PACKAGE_MANAGERS.find((m) => m.name === declared) ??
		PACKAGE_MANAGERS.find((m) => lockfiles.includes(m.lockfile)) ??
		npm
	);
}

/** One preview as REST answers it and the issue and chat show it. */
export const previewRecordSchema = z.strictObject({
	id: z.uuid(),
	projectId: z.uuid(),
	/** The issue whose run holds the worktree: a chat turn never writes code, so it opens none. */
	issueId: z.uuid(),
	/** The agent session whose worktree is served. */
	sessionId: z.uuid(),
	deviceId: z.uuid(),
	url: z.url(),
	state: z.enum(PREVIEW_STATES),
	reason: z.enum(PREVIEW_FAILURE_REASONS).nullable(),
	/** What a person reads about the state: the dev server's error, who abandoned it and why. */
	detail: z.string().max(PREVIEW_LIMITS.detail).nullable(),
	command: z.string().max(PREVIEW_LIMITS.command),
	port: z.int().nullable(),
	idleMinutes: z.int(),
	/** The patch id of the worktree's change against its base when approved: what the person saw. */
	approvedPatchId: z.string().nullable(),
	approvedBy: z.uuid().nullable(),
	createdBy: z.uuid(),
	createdAt: z.iso.datetime(),
	liveAt: z.iso.datetime().nullable(),
	lastViewedAt: z.iso.datetime().nullable(),
	closedAt: z.iso.datetime().nullable(),
});
export type PreviewRecord = z.infer<typeof previewRecordSchema>;

/** `{ preview }`: what open, abandon, the box's report and GET of one preview answer. */
export const previewEnvelopeSchema = z.strictObject({
	preview: previewRecordSchema,
});
export type PreviewEnvelope = z.infer<typeof previewEnvelopeSchema>;

/** `GET /api/issues/:issueId/preview`: the issue's latest preview, or `null` where it has had none. */
export const issuePreviewResponseSchema = z.strictObject({
	preview: previewRecordSchema.nullable(),
});
export type IssuePreviewResponse = z.infer<typeof issuePreviewResponseSchema>;

/**
 * `POST /api/previews/:id/ticket`: the address that spends the one-time ticket on the preview host
 * (it already carries `?ticket=`), and when the ticket stops working.
 */
export const previewTicketResponseSchema = z.strictObject({
	url: z.url(),
	expiresAt: z.iso.datetime(),
});
export type PreviewTicketResponse = z.infer<typeof previewTicketResponseSchema>;

/**
 * `POST /api/previews/:id/approve`: the approved preview, the lane its files take (the fast-lane
 * contract's `LaneDecision`, read there), the patch id approved, and whether the run was told.
 */
export const previewApproveResponseSchema = z.strictObject({
	preview: previewRecordSchema,
	lane: z.looseObject({ lane: z.enum(LANES) }),
	patchId: z.string(),
	runTold: z.boolean(),
});
export type PreviewApproveResponse = z.infer<
	typeof previewApproveResponseSchema
>;

/** `POST /api/previews/:id/messages` (202): the message reached the run's session. */
export const previewMessageResponseSchema = z.strictObject({
	sent: z.literal(true),
	seq: z.int(),
});
export type PreviewMessageResponse = z.infer<
	typeof previewMessageResponseSchema
>;

/**
 * What the runner reports about a preview (`POST /api/previews/:id/report`, device credential):
 * the repository facts for detection, the dev server up, its failure, or the change it serves.
 */
export const previewReportSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("facts"), facts: repositoryFactsSchema }),
	z.strictObject({
		kind: z.literal("live"),
		port: z.int().min(PREVIEW_LIMITS.port.min).max(PREVIEW_LIMITS.port.max),
	}),
	z.strictObject({
		kind: z.literal("failed"),
		reason: z.enum(PREVIEW_FAILURE_REASONS),
		detail: z.string().max(PREVIEW_LIMITS.detail),
	}),
	z.strictObject({
		kind: z.literal("snapshot"),
		base: wholeShaSchema("base"),
		/** `git patch-id --stable` of the worktree's diff against `base`, uncommitted edits included. */
		patchId: z.string().regex(/^[0-9a-f]{40}$/),
		files: z.array(z.string().max(1000)).max(2000),
	}),
]);
export type PreviewReport = z.infer<typeof previewReportSchema>;

/** Core to runner, on the device's control socket (`device:<id>` room). */
export interface PreviewControlFrames {
	"preview.start": {
		previewId: string;
		sessionId: string;
		/** Null when the project has no setting: the runner reports `facts` and waits for a second start. */
		settings: PreviewSettings | null;
		env: Record<string, string>;
		readyTimeoutSeconds: number;
	};
	"preview.stop": {
		previewId: string;
		why: "idle" | "approved" | "abandoned" | "failed";
	};
	/** Asked at approval; answered by a `snapshot` report. */
	"preview.snapshot.read": { previewId: string };
}

/** Pushed to the project room when a preview moves; web refetches it. */
export interface PreviewChangedFrame {
	previewId: string;
	projectId: string;
	issueId: string;
	state: PreviewState;
	reason: PreviewFailureReason | null;
	at: string;
}

/** A person asks for a change in the preview's run (BC-6); the run edits and the preview reloads. */
export const previewMessageRequestSchema = z.strictObject({
	text: z.string().trim().min(1).max(PREVIEW_LIMITS.message),
});

export const PREVIEW_REFUSAL_CODES = [
	"PREVIEW_NOT_FOUND",
	"PREVIEW_FORBIDDEN",
	"PREVIEW_TICKET_INVALID",
	"PREVIEW_CLOSED",
	"PREVIEW_NOT_LIVE",
	"PREVIEW_ALREADY_OPEN",
	"PREVIEW_NO_RUN",
	"PREVIEW_SETTINGS_INVALID",
	"PREVIEW_PRODUCTION_ENVIRONMENT",
	"PREVIEW_RUNNER_UNSUPPORTED",
	"PREVIEW_SNAPSHOT_UNAVAILABLE",
	"PREVIEW_DOMAIN_UNCONFIGURED",
	"PREVIEW_TUNNEL_DOWN",
] as const;
export type PreviewRefusalCode = (typeof PREVIEW_REFUSAL_CODES)[number];

/** The rest answer 422: change what the rule names (a setting, the run, the environment). */
export const PREVIEW_REFUSAL_STATUSES = {
	PREVIEW_NOT_FOUND: 404,
	PREVIEW_FORBIDDEN: 403,
	PREVIEW_TICKET_INVALID: 403,
	PREVIEW_CLOSED: 409,
	PREVIEW_NOT_LIVE: 409,
	PREVIEW_ALREADY_OPEN: 409,
	PREVIEW_SETTINGS_INVALID: 400,
	PREVIEW_SNAPSHOT_UNAVAILABLE: 503,
	PREVIEW_DOMAIN_UNCONFIGURED: 503,
	PREVIEW_TUNNEL_DOWN: 503,
} as const satisfies RefusalStatuses<PreviewRefusalCode>;

/** The REST surface the build lanes implement and call. `:id` is a preview, `:issueId` an issue. */
export const PREVIEW_ROUTES = {
	/** POST: open (or reopen) the preview of the issue's live run. GET: the issue's latest preview. */
	ofIssue: "/api/issues/:issueId/preview",
	get: "/api/previews/:id",
	/** POST: a one-time ticket for the iframe or tab to enter the preview host. */
	ticket: "/api/previews/:id/ticket",
	approve: "/api/previews/:id/approve",
	abandon: "/api/previews/:id/abandon",
	messages: "/api/previews/:id/messages",
	/** Runner only. */
	report: "/api/previews/:id/report",
	/** Runner only: the second WebSocket that carries preview bytes (`./preview-tunnel.ts`). */
	tunnel: "/ws/preview-tunnel",
} as const;

// ---- REQ-41 (docs/proposals/chat-first.md, "Idea preview" and "Reproduce"): a preview of something
// other than an issue's run. The shapes land here; the preview-subjects lane adds `subject` to
// `previewRecordSchema` (and makes `issueId` and `sessionId` nullable) with migration 0479 and the
// routes that serve it, and merges the codes and routes below into PREVIEW_REFUSAL_CODES and
// PREVIEW_ROUTES in that change, so nothing is named here that no route answers yet.

const REQUIREMENT_KEY = z.string().regex(/^REQ-\d{1,9}$/, "a requirement key such as REQ-30");
const FEEDBACK_KEY = z.string().regex(/^FB-\d{1,9}$/, "a feedback key such as FB-12");

/** A build a preview serves: the commit, and the release version where that commit is one. */
export const previewBuildSchema = z.strictObject({
	sha: wholeShaSchema("build.sha"),
	release: z.string().max(64).nullable(),
});
export type PreviewBuild = z.infer<typeof previewBuildSchema>;

/**
 * What a preview serves. `issue`: the worktree of an issue's run (REQ-39). `idea`: a throwaway
 * branch a sketch run edits from chat, about one requirement or feedback item, merged nowhere
 * (BC-14, BC-15). `reproduce`: a past build checked out with no run at all, for a feedback item
 * (BC-17), recorded while it is used (BC-18).
 */
export const PREVIEW_SUBJECT_KINDS = ["issue", "idea", "reproduce"] as const;
export type PreviewSubjectKind = (typeof PREVIEW_SUBJECT_KINDS)[number];

/** The branch a sketch run edits: `sketch/` and the item it is about, never pushed. */
export const SKETCH_BRANCH = /^sketch\/(req|fb)-\d{1,9}-[a-z2-7]{6}$/;

export const previewSubjectSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("issue"), issueId: z.uuid() }),
	z.strictObject({
		kind: z.literal("idea"),
		about: z.discriminatedUnion("kind", [
			z.strictObject({ kind: z.literal("requirement"), key: REQUIREMENT_KEY }),
			z.strictObject({ kind: z.literal("feedback"), key: FEEDBACK_KEY }),
		]),
		branch: z.string().regex(SKETCH_BRANCH, "a sketch branch such as sketch/fb-51-abcdef"),
	}),
	z.strictObject({
		kind: z.literal("reproduce"),
		feedback: FEEDBACK_KEY,
		build: previewBuildSchema,
		/** Whether the relay injects the recorder (`./reproduce.ts`). */
		record: z.boolean(),
	}),
]);
export type PreviewSubject = z.infer<typeof previewSubjectSchema>;

export const PREVIEW_IDEA_LIMITS = {
	/** What the person asked for, as the sketch run is briefed with it. */
	brief: 4000,
	/** The screenshots a kept preview holds as the requirement's picture. */
	shots: 6,
	/** A kept patch, in bytes: a sketch is a sketch. */
	patchBytes: 512 * 1024,
} as const;

/**
 * `POST /api/projects/:id/previews`: open a preview that no issue's run holds. An idea is built by a
 * sketch run from `brief` (optionally starting from a kept preview's patch); a reproduce serves the
 * build named, or, with none named, the build the reporter was using when they filed the item
 * (PREVIEW_BUILD_UNKNOWN where Forge cannot tell which, naming what to give).
 */
export const openPreviewRequestSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("idea"),
		about: z.union([REQUIREMENT_KEY, FEEDBACK_KEY]),
		brief: z.string().trim().min(1).max(PREVIEW_IDEA_LIMITS.brief),
		/** A kept preview whose patch the sketch starts from, to edit an idea already kept. */
		from: z.uuid().optional(),
	}),
	z.strictObject({
		kind: z.literal("reproduce"),
		feedback: FEEDBACK_KEY,
		build: z
			.union([
				z.strictObject({ release: z.string().trim().min(1).max(64) }),
				z.strictObject({ sha: wholeShaSchema("build.sha") }),
			])
			.optional(),
		record: z.boolean().default(true),
	}),
]);
export type OpenPreviewRequest = z.infer<typeof openPreviewRequestSchema>;

/**
 * `POST /api/previews/:id/keep`: an idea preview kept as its requirement's picture (BC-16). About a
 * requirement, it becomes that requirement's head revision's picture; about a feedback item, it
 * goes to the item's new requirement draft (triage route `new_requirement`), whose criteria the
 * assistant drafts from the preview's conversation and change.
 */
export const keepPreviewRequestSchema = z.strictObject({
	/** What the picture shows, in a sentence a screen reader reads (`RequirementPictureView.alt`). */
	alt: z.string().trim().min(1).max(300),
});

/** A kept preview as a requirement picture holds it: what was served, and what it looked like. */
export const keptPreviewContentSchema = z.strictObject({
	previewId: z.uuid(),
	base: wholeShaSchema("base"),
	patchId: z.string().regex(/^[0-9a-f]{40}$/),
	files: z.array(z.string().max(1000)).max(2000),
	/** Screenshots taken at keep, each an upload of the requirement with its own text alternative. */
	shots: z
		.array(z.strictObject({ upload: z.uuid(), alt: z.string().trim().min(1).max(300) }))
		.min(1)
		.max(PREVIEW_IDEA_LIMITS.shots),
	/** The briefs and chat edits the sketch was built from, oldest first. */
	asked: z.array(z.string().max(PREVIEW_IDEA_LIMITS.brief)).min(1).max(50),
});
export type KeptPreviewContent = z.infer<typeof keptPreviewContentSchema>;

/**
 * How a reproduce preview gets its data (BC-22): the project's demo data where the preview setting
 * names it, else the environment its dev server already uses; a production-tier environment is
 * refused either way (PREVIEW_PRODUCTION_ENVIRONMENT, REQ-39 BC-13). `seed` runs in the checkout
 * before the dev server starts. Merged into `previewSettingsSchema` as `demo` by the reproduce lane.
 */
export const previewDemoSettingsSchema = z
	.strictObject({
		environment: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]*$/)
			.max(60)
			.optional(),
		seed: z.string().trim().min(1).max(PREVIEW_LIMITS.command).optional(),
	})
	.refine((d) => d.environment !== undefined || d.seed !== undefined, {
		message: "preview.demo names a demo environment, a seed command, or both",
	});
export type PreviewDemoSettings = z.infer<typeof previewDemoSettingsSchema>;

/** Where a reproduce preview's data comes from, before the production check core makes on the tier. */
export function reproduceDataOf(
	settings: { environment?: string; demo?: PreviewDemoSettings },
): { kind: "demo"; environment: string | null; seed: string | null } | { kind: "environment"; environment: string | null } {
	if (settings.demo) {
		return {
			kind: "demo",
			environment: settings.demo.environment ?? settings.environment ?? null,
			seed: settings.demo.seed ?? null,
		};
	}
	return { kind: "environment", environment: settings.environment ?? null };
}

export const PREVIEW_SUBJECT_REFUSAL_CODES = [
	/** The requirement or feedback item an idea or a reproduce names is not this project's. */
	"PREVIEW_ITEM_UNKNOWN",
	/** No build was named and Forge cannot tell which the reporter used: name a release or a sha. */
	"PREVIEW_BUILD_UNKNOWN",
	/** Only an idea preview is kept as a picture; an issue's preview is approved, a reproduce is not kept. */
	"PREVIEW_KEEP_NOT_IDEA",
	/** A confirm is made on the preview of an issue a feedback item routes to, and this is not one. */
	"PREVIEW_CONFIRM_NOT_FIX",
	/** "Not fixed" says what is still wrong. */
	"PREVIEW_CONFIRM_REASON_REQUIRED",
] as const;
export type PreviewSubjectRefusalCode = (typeof PREVIEW_SUBJECT_REFUSAL_CODES)[number];

export const PREVIEW_SUBJECT_REFUSAL_STATUSES = {
	PREVIEW_ITEM_UNKNOWN: 404,
	PREVIEW_KEEP_NOT_IDEA: 409,
	PREVIEW_CONFIRM_NOT_FIX: 409,
	PREVIEW_CONFIRM_REASON_REQUIRED: 400,
} as const satisfies RefusalStatuses<PreviewSubjectRefusalCode>;

/** `POST /api/previews/:id/confirm`: whoever reported it, or anyone on the project for them, says whether the fix preview fixes it (BC-20). */
export const confirmFixRequestSchema = z
	.strictObject({
		verdict: z.enum(["fixed", "not_fixed"]),
		note: z.string().trim().max(REASON_PARAGRAPH_MAX).optional(),
	})
	.refine((c) => c.verdict === "fixed" || (c.note !== undefined && c.note !== ""), {
		message: "PREVIEW_CONFIRM_REASON_REQUIRED: not fixed says what is still wrong",
		path: ["note"],
	});
export type ConfirmFixRequest = z.infer<typeof confirmFixRequestSchema>;

export const PREVIEW_SUBJECT_ROUTES = {
	/** POST: open an idea or a reproduce preview. */
	open: "/api/projects/:id/previews",
	keep: "/api/previews/:id/keep",
	confirm: "/api/previews/:id/confirm",
} as const;
