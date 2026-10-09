// A live preview (REQ-39 "See a change live before it ships"; docs/proposals/live-preview.md): the
// dev server a run starts in its worktree, served to the project's members from a Forge link while
// the change is being made. Core decides who may view it and for how long; the runner only starts
// the dev server and carries its bytes (`./preview-tunnel.ts`). This module is the record, its
// machine, why one fails, the refusals, the project setting and how the setting is read from the
// repository when unset.

import { z } from "zod";
import { wholeShaSchema } from "./check-runs.js";
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
