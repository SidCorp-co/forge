/** Patch body accepted by `PATCH /api/projects/:id` (basics + repo + testing).
 *  `orgId` moves the project to another org — requires org admin on BOTH the
 *  current and the destination org (403/404 otherwise). */
export interface ProjectUpdateInput {
	name?: string;
	description?: string | null;
	repoPath?: string | null;
	repoUrl?: string | null;
	/** Prose: how to bring this repo's workspace to a buildable state. Read by
	 *  the runner's setup agent; blank means it derives the procedure per job. */
	workspaceSetup?: string | null;
	baseBranch?: string | null;
	liveBranch?: string | null;
	releaseModel?: "none" | "promote" | "publish";
	releaseStrategy?: "merge-branch" | "cherry-pick" | "tag-mr" | null;
	environments?: EnvironmentsConfig | null;
	orgId?: string;
	/** ISS-609 — chat/RC-bot reply-style knob; scoped server-side write into
	 *  `agentConfig.personaStyle`. null/'' clears it. */
	personaStyle?: string | null;
	rocketChatAnswerMode?: "fast" | "agent" | null;
	systemPrompt?: string | null;
	categories?: string[] | null;
}

/** One `environments.preview.urls` row — mirrors `testingUrlSchema` in core. */
export interface TestingUrl {
	label: string;
	url: string;
}

/** One `environments.testCredentials` row — mirrors `testCredentialSchema`. */
export interface TestCredential {
	label: string;
	username: string;
	password: string;
}

/** The preview side — `null` on the column means this project HAS no preview side. */
export interface PreviewEnvironmentConfig {
	url?: string | null;
	apiUrl?: string | null;
	urls?: TestingUrl[];
	[key: string]: unknown;
}

/**
 * The live side — the address a release ships to.
 *
 * `commitUrl` is a SEPARATE address from `url`: it is the endpoint that reports the running
 * commit, and `commitPath` is the dot path to it inside that endpoint's JSON body. Neither is
 * derivable from `url`, which is why all three are stored (ISS-1069).
 */
export interface LiveEnvironmentConfig {
	url?: string | null;
	apiUrl?: string | null;
	commitUrl?: string | null;
	commitPath?: string | null;
	[key: string]: unknown;
}

export interface EnvironmentsConfig {
	preview?: PreviewEnvironmentConfig | null;
	live?: LiveEnvironmentConfig | null;
	testCredentials?: TestCredential[];
	/** ISS-1069 — what this environment does NOT have. Read by agents before they plan a live
	 *  walk. Never a secret. Replaced `notes`, which invited anything and was set on 4 of 32. */
	limits?: string | null;
	[key: string]: unknown;
}

/** One row of `GET /api/projects/:id/members` — includes the member email. */
export interface ProjectMemberRow {
	userId: string;
	email: string;
	role: "admin" | "member" | "viewer";
	createdAt: string;
}

/** One row of `GET /api/projects/:id/members/invitations` — a pending invite. */
export interface ProjectInvitationRow {
	email: string;
	role: "admin" | "member" | "viewer";
	expiresAt: string;
	createdAt: string;
	inviterEmail: string;
	expired: boolean;
}

/** A label's taxonomy role — a module IS a label carrying `kind: 'module'`. */
export type LabelKind = "label" | "module";

/** A project label (`GET /api/projects/:id/labels`), modules included. */
export interface ProjectLabel {
	id: string;
	name: string;
	color: string;
	kind: LabelKind;
	/** Modules only — the parent module, or null at the root of the taxonomy. */
	parentId: string | null;
	/** Modules only — the module's stable identity, derived from its name on create and never moved by a rename. */
	slug: string | null;
	/** Modules only — the module's knowledge node, or null when nobody has written one yet. */
	knowledgeEntryId: string | null;
	description: string | null;
}

/** Body for creating a label or a module. `color` may be omitted for a module — the server
 *  derives a stable one from the name; it is REQUIRED for a plain label. */
export interface LabelCreateInput {
	name: string;
	color?: string;
	kind?: LabelKind;
	parentId?: string | null;
	description?: string | null;
}

/** Body for `PATCH /api/labels/:id`. Every field optional; at least one required. */
export type LabelPatchInput = Partial<LabelCreateInput>;

/**
 * One `states[<status>]` entry — mirrors `stageConfigSchema` in core
 * `pipeline/pipeline-config-schema.ts`. The tab edits `enabled`/`mode`,
 * `allowedTools`/`disallowedTools`, `mcpServers` and `deviceIds`; the index
 * signature keeps every other key round-tripping on save.
 */
export interface PipelineStateConfig {
	enabled?: boolean;
	/**
	 * ENTRY STATUS ONLY (`open`). `isEntryGateClosed` is the field's one reader
	 * and reads `states.open`; core refuses a PATCH that sets it anywhere else
	 * and strips a stored one on read. The tab already writes it on `open`
	 * alone — see `withEntryGate` in `components/pipeline-tab.tsx`.
	 */
	mode?: "auto" | "manual";
	model?: string;
	allowedTools?: string[] | null;
	disallowedTools?: string[] | null;
	permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
	timeoutSeconds?: number;
	/** Per-state MCP servers — overrides the project-default `mcpServers` above. */
	mcpServers?: Record<string, unknown>;
	systemPrompt?: { mode?: "append" | "replace"; extras?: string | null };
	userPromptPolicy?: Record<string, unknown>;
	budget?: { perRunUsd?: number; perMonthUsd?: number; action?: "warn" | "pause" };
	/** Runner pool — the only devices this stage's jobs may land on. Empty/absent = whole fleet. */
	deviceIds?: string[];
	[key: string]: unknown;
}

/**
 * A Claude Code plugin the project designates (installed at DEVICE scope —
 * a device installs the union of every project it serves). Mirrors
 * `pluginDesignationSchema` in core `plugins/designation.ts`. Stored at
 * `agentConfig.plugins`, read via `GET /api/projects/:id`.
 */
export interface PluginDesignation {
	marketplace: string;
	name: string;
	pinnedRef?: string | null;
	autoUpdate?: boolean;
}

/** One reason a release will not start, and what to do about it — mirrors
 *  `ReleaseBlocker` in core `release-batch/blocker-sentences.ts`. */
export interface ReleaseBlocker {
	code: string;
	/** The one sentence an operator reads, carrying its own remedy. */
	message: string;
	details?: Record<string, unknown>;
	/** False when this check could not be run at all. */
	evaluated: boolean;
}

/** Something that changes how a release runs without being a reason it will not. */
export interface ReleaseWarning {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

/** What a project still has to declare — mirrors `ReleaseReadiness` in core
 *  `release-batch/readiness.ts`. `gaps` is what settings says out loud. */
export interface ReleaseReadiness {
	/** The project declares a release model AND has an active live deploy binding. */
	hasReleaseGate: boolean;
	releaseModel: "none" | "promote" | "publish";
	releaseStrategy: "merge-branch" | "cherry-pick" | "tag-mr" | null;
	baseBranch: string;
	/** Non-null only under `promote` — every other model reads no branch. */
	liveBranch: string | null;
	targetUndeclared: boolean;
	/** Providers of EVERY live deploy binding; core never picks one. */
	providers: string[];
	releaseRunnerLabel: string | null;
	rollback: string | null;
	rollbackMode: "manual" | "coolify-image" | "unrepresentable" | null;
	hasVerify: boolean;
	/** False where the declaration could not be READ, which makes every field
	 *  below a fallback rather than a reading (ISS-1127). */
	declarationRead: boolean;
	/** False where the live bindings could not be READ, which makes providers,
	 *  rollback, hasVerify and the runner label fallbacks (ISS-1127). */
	channelsRead: boolean;
	/** Every reason a release would be refused RIGHT NOW — the declarations, and
	 *  also the roster and the fleet, which `gaps` never looked at. Empty here
	 *  means a release over this roster starts (ISS-1127). */
	blockers: ReleaseBlocker[];
	/** What changes how the release runs without stopping it. */
	warnings: ReleaseWarning[];
	gaps: (
		| "build-commands"
		| "test-commands"
		| "release-procedure"
		| "release-runner"
		| "release-runner-ambiguous"
		| "release-multi-channel"
		| "release-target"
		| "rollback"
		| "rollback-prose"
		| "verify-probes"
		| "live-commit-endpoint"
	)[];
}

export interface ProjectAgentConfig {
	pipelineConfig?: PipelineConfig;
	plugins?: PluginDesignation[];
	personaStyle?: string;
	systemPrompt?: string;
	rocketChatAnswerMode?: "fast" | "agent";
	categories?: string[];
}

/**
 * Loosely-typed pipeline config. This screen edits a handful of keys and
 * carries the rest through opaquely, so a PATCH never drops what it does not
 * surface. `pipelineConfigPatchSchema` requires `states`, so the full fetched
 * object always goes back.
 */
export interface PipelineConfig {
	enabled?: boolean;
	mcpServers?: Record<string, unknown>;
	/**
	 * Per-stage overrides, keyed by ISSUE STATUS (not step name) — mirrors
	 * `statesConfigSchema` in core. See `PipelineStateConfig` above.
	 */
	states?: Record<string, PipelineStateConfig | undefined>;
	intakeGate?: { enabled: boolean; notify?: boolean };
	poolBacklog?: { statuses: string[]; limit?: number };
	/**
	 * Per-project knowledge promotion. When enabled, the nightly memory
	 * consolidation job (03:00 UTC) files up to `candidatesPerRun` `open` issues
	 * proposing durable memories for the curated knowledge store. Absent = off.
	 * Mirrors `knowledgePromotion` in core `pipeline/pipeline-config-schema.ts`.
	 */
	knowledgePromotion?: {
		enabled: boolean;
		candidatesPerRun?: number;
		minRetrievals?: number;
	};
	assistantWeekly?: {
		enabled: boolean;
		pinnedIssue: string;
		judgeProviderId: string;
		judgeModel: string;
		source?: string;
	};
	autoProdDeploy?: boolean;
	[key: string]: unknown;
}

/**
 * Built-in catalog of known secret-free MCP servers, mirrored from core's
 * `pipeline/mcp-catalog.ts` for the settings UI. Cross-app parity: when a new
 * secret-free catalog entry is added in core, add the matching descriptor here
 * so the toggle list surfaces it.
 *
 * Anything needing a token or API key is NOT a catalog default and has no entry in this map at
 * all. It is an integration, and whether an agent may use one is `agentAccess` on the binding —
 * granted on the Integrations tab. Writing its name into `mcpServers` injects nothing.
 */
export const MCP_CATALOG: Record<
	string,
	{ label: string; hint: string; spec: Record<string, unknown> }
> = {
	playwright: {
		label: "Playwright",
		hint: "Headless browser automation for live E2E / UI verification.",
		spec: {
			type: "stdio",
			command: "npx",
			args: ["@playwright/mcp@latest"],
			env: {},
		},
	},
	"chrome-devtools-mcp": {
		label: "Chrome DevTools",
		hint: "Chrome DevTools Protocol access for browser inspection, debugging, performance traces, and network monitoring.",
		spec: {
			type: "stdio",
			command: "npx",
			args: ["chrome-devtools-mcp@latest"],
			env: {},
		},
	},
};

export const MCP_CATALOG_NAMES = Object.keys(MCP_CATALOG);

export const PIPELINE_STATUS_ROWS: ReadonlyArray<{ status: string; label: string }> = [
	{ status: "open", label: "Queued" },
	{ status: "in_progress", label: "Running" },
	{ status: "needs_info", label: "Needs a human" },
	{ status: "awaiting_release", label: "Awaiting release" },
];

const PIPELINE_STATUS_LABELS: Record<string, string> = Object.fromEntries(
	PIPELINE_STATUS_ROWS.map((r) => [r.status, r.label]),
);

/** status → step label; falls back to the raw status for one core doesn't list here yet. */
export function pipelineStatusLabel(status: string): string {
	return PIPELINE_STATUS_LABELS[status] ?? status;
}

export interface HumanizedToolName {
	label: string;
	server: string | null;
	raw: string;
}

function toSentenceCase(words: string[]): string {
	return words
		.map((w, i) => {
			const lower = w.toLowerCase();
			return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
		})
		.join(" ");
}

/** "CronCreate" -> ["Cron","Create"]; "Workflow" -> ["Workflow"]. */
function splitPascalCase(raw: string): string[] {
	return raw
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/\s+/)
		.filter(Boolean);
}

export function humanizeToolName(raw: string): HumanizedToolName {
	if (raw.startsWith("mcp__")) {
		const parts = raw.split("__");
		const server = parts[1] ?? null;
		let rest = parts.slice(2).join("__");
		if (server && rest.startsWith(`${server}_`)) rest = rest.slice(server.length + 1);
		const words = rest.split("_").filter(Boolean);
		return { label: words.length > 0 ? toSentenceCase(words) : rest, server, raw };
	}
	const words = splitPascalCase(raw);
	return { label: words.length > 0 ? toSentenceCase(words) : raw, server: null, raw };
}

/** Tool ids bucketed by their MCP server, builtins under "Built-in". Shared by
 *  the read-only chip display and the editor so both group identically. */
export function groupByServer(tools: string[]): Array<[string, string[]]> {
	const groups = new Map<string, string[]>();
	for (const raw of tools) {
		const { server } = humanizeToolName(raw);
		const key = server ?? "Built-in";
		const list = groups.get(key) ?? [];
		list.push(raw);
		groups.set(key, list);
	}
	return [...groups.entries()];
}

/** One stage row worth rendering on the Stage permissions section — carries
 *  any of allowedTools / disallowedTools / mcpServers / deviceIds. */
export interface StagePermissionRow {
	status: string;
	label: string;
	config: PipelineStateConfig;
}

function stageHasOverride(sc: PipelineStateConfig): boolean {
	return (
		(sc.allowedTools?.length ?? 0) > 0 ||
		(sc.disallowedTools?.length ?? 0) > 0 ||
		Object.keys(sc.mcpServers ?? {}).length > 0 ||
		(sc.deviceIds?.length ?? 0) > 0
	);
}

/** Every `states[status]` that carries a permission-relevant override, in
 *  ladder order. */
export function summarizeStageConfig(cfg: PipelineConfig): StagePermissionRow[] {
	const states = (cfg.states ?? {}) as Record<string, PipelineStateConfig>;
	const rows: StagePermissionRow[] = [];

	for (const { status, label } of PIPELINE_STATUS_ROWS) {
		const sc = states[status];
		if (sc && stageHasOverride(sc)) rows.push({ status, label, config: sc });
	}
	return rows;
}

/** Per-row diff against the modal `disallowedTools` signature (the set shared
 *  by the most stages). `missing` = tools the baseline denies that this stage
 *  does NOT — i.e. tools this stage is allowed to use that most others aren't. */
export interface DenylistDiff {
	status: string;
	isOutlier: boolean;
	extra: string[];
	missing: string[];
}

export function denylistBaseline(rows: StagePermissionRow[]): DenylistDiff[] {
	const counts = new Map<string, { set: Set<string>; count: number }>();
	for (const row of rows) {
		const tools = row.config.disallowedTools ?? [];
		if (tools.length === 0) continue;
		const key = [...tools].sort().join("\u0000");
		const entry = counts.get(key) ?? { set: new Set(tools), count: 0 };
		entry.count += 1;
		counts.set(key, entry);
	}
	let baseline = new Set<string>();
	let bestCount = -1;
	for (const { set, count } of counts.values()) {
		if (count > bestCount) {
			bestCount = count;
			baseline = set;
		}
	}
	return rows.map((row) => {
		const tools = new Set(row.config.disallowedTools ?? []);
		const missing = [...baseline].filter((t) => !tools.has(t));
		const extra = [...tools].filter((t) => !baseline.has(t));
		return { status: row.status, isOutlier: missing.length > 0 || extra.length > 0, extra, missing };
	});
}

export function withStagePatch(
	cfg: PipelineConfig,
	status: string,
	patch: PipelineStateConfig,
): PipelineConfig {
	const states = (cfg.states ?? {}) as Record<string, PipelineStateConfig | undefined>;
	return {
		...cfg,
		states: { ...states, [status]: { ...(states[status] ?? {}), ...patch } },
	};
}

/** Every tool id already named anywhere in the config — the add-picker's seed.
 *  No canonical registry of Claude Code tool ids exists to draw from, so what
 *  the project already uses is the honest list and a novel id is typed in. */
export function knownToolIds(cfg: PipelineConfig): string[] {
	const seen = new Set<string>();
	for (const sc of Object.values((cfg.states ?? {}) as Record<string, PipelineStateConfig>)) {
		for (const t of sc?.allowedTools ?? []) seen.add(t);
		for (const t of sc?.disallowedTools ?? []) seen.add(t);
	}
	return [...seen].sort();
}

/** Config keys the settings API accepts that this screen deliberately does not
 *  surface — driving the "configured elsewhere" note (invariant D: an
 *  unsurfaced key must state why, never go silent). Every row must name a key
 *  something in core actually reads; a row for a key with no reader is a
 *  promise that the knob does something. */
export interface ApiOnlyKey {
	key: string;
	reason: string;
}

export const API_ONLY_KEYS: ApiOnlyKey[] = [
	{
		key: "states[*].model",
		reason:
			"Opaque input passed straight to the runner adapter; an unset value resolves to a per-stage default, so a raw string here would misrepresent what actually runs.",
	},
	{
		key: "states[*].permissionMode",
		reason:
			"Controls the Claude CLI's own approval mode, and `bypassPermissions` is flagged by the security config policy — a lever that belongs with a review of what it unlocks, not with a toggle.",
	},
	{
		key: "states[*].timeoutSeconds",
		reason:
			"Per-stage job timeout. Read at dispatch; too coarse to set without knowing what a stage's longest legitimate run looks like on this fleet.",
	},
	{
		key: "states[*].budget",
		reason:
			"Per-stage spend caps, read before dispatch and enforced in flight. Deferred with the model above rather than given a form: a cap set wrong stops a stage dispatching, and the number belongs with a view of what the stage actually spends.",
	},
	{
		key: "states[*].systemPrompt",
		reason: "Raw prompt override (append/replace) — high blast radius, deferred pending a dedicated review surface.",
	},
	{
		key: "states[*].userPromptPolicy",
		reason:
			"Prompt field/truncation tuning, including handoff injection — a token-budget decision measured against real prompts, not guessed from a form.",
	},
	{
		key: "maxResumeTokens",
		reason:
			"Session-resume budget guard (ISS-580), read by `jobs/session-resume.ts`. Project-level rather than per-stage, so it has no home in the per-stage editor above.",
	},
];


export type MemoryModel = "flat" | "chunked";

export const MEMORY_REINDEX_STATES = [
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;
export type MemoryReindexState = (typeof MEMORY_REINDEX_STATES)[number];

/** `app_config.memory_reindex` as `GET /api/app-config/:id/memory-model/reindex` returns it. */
export interface MemoryReindex {
	state: MemoryReindexState;
	total: number;
	done: number;
	remaining: number;
	requestedAt: string;
	startedAt?: string;
	finishedAt?: string;
	lastBatchAt?: string;
	lastError?: string;
}

export interface MemoryModelStatus {
	model: MemoryModel;
	reindex: MemoryReindex | null;
}

/** `GET /api/app-config/:id/memory-model/estimate` — CHUNKED_SOURCES rows only. */
export interface MemoryReindexEstimate {
	memories: number;
	totalChars: number;
	estimatedChunks: number;
	estimatedEmbedCalls: number;
	estimatedMinutes: number;
}
