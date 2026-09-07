import type { UxPreset, UxRuleGroup, UxRuleSource, UxStackProfile } from "@forge/contracts";

export type {
	ApplyUxPresetInput,
	UxContractRule,
	UxContractRulePatch,
	UxFinding,
	UxPreset,
	UxRuleGroup,
	UxRuleSeverity,
	UxRuleSource,
	UxRuleStatus,
	UxStackProfile,
	UxToggleSettings,
} from "@forge/contracts";

// cm:edge contract -> packages/core/src/projects/project-facts.ts — the project-facts shapes below are hand-mirrored from `projectFactsPatchSchema`; the always-inject tier is injected verbatim into every agent prompt, so a key added there and not here is silently undisplayable
/** Per-key config map; `alwaysInject` flags a fact for verbatim injection. */
export type ProjectFactsConfig = Record<string, { alwaysInject?: boolean }>;

/** `GET /api/projects/:id/project-facts` response shape. */
export interface ProjectFactsResponse {
	/** kebab-key → guide text. */
	projectFacts: Record<string, string>;
	projectFactsConfig: ProjectFactsConfig;
	/** Char budget for the SUM of always-inject bodies (warn-on-overflow). */
	maxAlwaysInjectChars: number;
}

/** `PATCH /api/projects/:id/project-facts` body. Per-key merge: a `null` value
 *  removes that key; omit a map to leave it untouched. */
export interface ProjectFactsPatch {
	projectFacts?: Record<string, string | null> | null;
	projectFactsConfig?: Record<string, { alwaysInject?: boolean } | null> | null;
}

/** Reserved (derived) keys the server ignores — surfaced for inline validation
 *  so the UI rejects them before a round-trip. Mirrors
 *  `RESERVED_PROJECT_FACT_KEYS` in core `projects/project-facts.ts`. */
export const RESERVED_PROJECT_FACT_KEYS = [
	"base-branch",
	"production-branch",
	"repo-path",
	"test-urls",
	"test-creds",
	"integrations",
] as const;

/** Max length of a single fact body (mirrors `projectFactsPatchSchema`). */
export const PROJECT_FACT_MAX_CHARS = 8000;

/** Kebab-case key pattern (mirrors `projectFactKeySchema`). */
export const PROJECT_FACT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
	productionBranch?: string | null;
	previewDeploy?: PreviewDeployConfig | null;
	orgId?: string;
	/** ISS-609 — chat/RC-bot reply-style knob; scoped server-side write into
	 *  `agentConfig.personaStyle`. null/'' clears it. */
	personaStyle?: string | null;
	/** ISS-727 — RC bot answer-engine knob; scoped server-side write into
	 *  `agentConfig.rocketChatAnswerMode`. null clears it (reverts to `fast`). */
	rocketChatAnswerMode?: "fast" | "agent" | null;
	/** ISS-814 — per-jobType agent context; scoped server-side write into
	 *  `agentConfig.stateContext`. Merged per key: a `null` entry removes that
	 *  jobType, an omitted one is untouched, `null` for the map wipes it. */
	stateContext?: Record<string, StateContextEntry | null> | null;
}

/** One `previewDeploy.testingUrls` row — mirrors `testingUrlSchema` in core. */
export interface TestingUrl {
	label: string;
	url: string;
}

/** One `previewDeploy.testCredentials` row — mirrors `testCredentialSchema`. */
export interface TestCredential {
	label: string;
	username: string;
	password: string;
}

/**
 * The `previewDeploy` jsonb blob on a project — staging endpoints + the testing
 * URLs / credentials QA uses against a deployment. Mirrors the known keys of
 * `previewDeployPatchSchema` in `packages/core/src/projects/routes.ts`; the
 * server schema is `.catchall(z.unknown())`, so unknown keys round-trip
 * untouched (the Testing tab spreads the stored blob on save to preserve them).
 * `Project.previewDeploy` is untyped jsonb (`unknown`) — cast through this.
 */
export interface PreviewDeployConfig {
	stagingUrl?: string | null;
	stagingApiUrl?: string | null;
	testingUrls?: TestingUrl[];
	testCredentials?: TestCredential[];
	/** ISS-767 — how to use the resources above and, more importantly, what they
	 *  CANNOT do. Read by agents before they plan a live walk. Never a secret. */
	notes?: string | null;
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
// cm:edge contract -> packages/core/src/db/schema.ts#labelKinds — a third kind added there and not here is a row the Modules tab shows as a plain label and the Labels tab shows as a module
export type LabelKind = "label" | "module";

/** A project label (`GET /api/projects/:id/labels`), modules included. */
// cm:edge contract -> packages/core/src/labels/routes.ts#labelColumns — every route in that file projects exactly this set; `color` is NOT NULL in the schema and every projection carries it, so there is no null arm
export interface ProjectLabel {
	id: string;
	name: string;
	color: string;
	kind: LabelKind;
	/** Modules only — the parent module, or null at the root of the taxonomy. */
	parentId: string | null;
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
	mode?: "auto" | "manual";
	skillName?: string;
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

/** What a project still has to declare — mirrors `ReleaseReadiness` in core
 *  `release-batch/readiness.ts`. `gaps` is what settings says out loud. */
export interface ReleaseReadiness {
	hasProduction: boolean;
	baseBranch: string;
	productionBranch: string;
	provider: string | null;
	releaseRunnerLabel: string | null;
	rollback: string | null;
	rollbackMode: "manual" | "coolify-image" | "unrepresentable" | null;
	hasVerify: boolean;
	gaps: (
		| "build-commands"
		| "test-commands"
		| "release-procedure"
		| "release-runner"
		| "rollback"
		| "rollback-prose"
	)[];
}

/** One `agentConfig.stateContext[<jobType>]` entry — mirrors
 *  `stateContextEntrySchema` in core `projects/state-context.ts`. */
export interface StateContextEntry {
	modelOverride?: string | null;
	budget?: { perRunUsd?: number; perMonthUsd?: number; action?: "warn" | "pause" };
	blocks?: Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * The `agentConfig` jsonb blob on a project — read-only surface for plugins +
 * stateContext (ISS-813). `Project.agentConfig` is untyped jsonb (`unknown`),
 * same reason `previewDeploy` needs `PreviewDeployConfig` — cast through this,
 * as `rocketchat-section.tsx:89` already does for `agentConfig.rocketChatAnswerMode`.
 */
export interface ProjectAgentConfig {
	plugins?: PluginDesignation[];
	stateContext?: Record<string, StateContextEntry> | null;
	/** ISS-578 stack profile, persisted by `POST .../ux-contract/apply-preset`. */
	uxContractProfile?: UxStackProfile;
	[key: string]: unknown;
}

// cm:edge contract -> packages/core/src/projects/ux-contract-presets.ts — the UxStackProfile union and the rule/finding enums are hand-mirrored here; a value added on one side typechecks and then fails at the column or renders as an unknown badge

export const UX_RULE_GROUPS = [
	"designSystem",
	"states",
	"flows",
	"a11y",
	"microcopy",
	"responsive",
] as const satisfies readonly UxRuleGroup[];

/** §1–6 display labels, in canonical contract order. */
export const UX_RULE_GROUP_LABELS: Record<UxRuleGroup, string> = {
	designSystem: "§1 Design system",
	states: "§2 States",
	flows: "§3 Flows & feedback",
	a11y: "§4 Accessibility",
	microcopy: "§5 Microcopy",
	responsive: "§6 Responsive",
};

export const UX_RULE_SOURCE_LABELS: Record<UxRuleSource, string> = {
	preset: "Preset",
	detected: "Detected",
	learned: "Learned",
	manual: "Manual",
};

export const UX_PRESETS = [
	"app-strict",
	"marketing",
	"internal-tool",
	"custom",
] as const satisfies readonly UxPreset[];

export const UX_PRESET_LABELS: Record<UxPreset, string> = {
	"app-strict": "App (strict)",
	marketing: "Marketing site",
	"internal-tool": "Internal tool",
	custom: "Custom",
};

/** `POST /api/projects/:id/ux-contract/apply-preset` body and rule transport
 * shapes are imported from the shared `@forge/contracts` type-only boundary. */

/**
 * Loosely-typed pipeline config. This screen edits a handful of keys and
 * carries the rest through opaquely, so a PATCH never drops what it does not
 * surface. `pipelineConfigPatchSchema` requires `states`, so the full fetched
 * object always goes back.
 */
export interface PipelineConfig {
	enabled?: boolean;
	/**
	 * Project-default MCP servers seeded into every dispatched job's temp
	 * `--mcp-config` (forge-runner `--strict-mcp-config` ignores the runner
	 * box's own MCP config, so the project must declare the secret-free servers
	 * it wants). Shorthand: `name: true` enables a catalog default (see
	 * `MCP_CATALOG`); an object value is a raw custom spec; `false`/absent omits.
	 * The dispatcher merges this as the base, with per-state `states[x].mcpServers`
	 * and integration servers (postman/epodsystem) layering on top.
	 */
	mcpServers?: Record<string, unknown>;
	/**
	 * Per-stage overrides, keyed by ISSUE STATUS (not step name) — mirrors
	 * `statesConfigSchema` in core. See `PipelineStateConfig` above.
	 */
	states?: Record<string, PipelineStateConfig | undefined>;
	/**
	 * ISS-606 — per-project intake gate. When enabled, EVERY create that would
	 * land at `open` (all channels, member-created included) parks at `draft`
	 * + label `intake` until a human approves via draft→open. `notify`
	 * (default true) pings the project owner on each gated arrival. Mirrors
	 * `intakeGate` in core `pipeline/pipeline-config-schema.ts`.
	 */
	intakeGate?: { enabled: boolean; notify?: boolean };
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
	/**
	 * When true, production Coolify deploys auto-dispatch on release instead of
	 * parking at the manual human-confirm gate (mirrors `autoProdDeploy` in core
	 * `pipeline/pipeline-config-schema.ts`). Absent/false (the default) keeps the
	 * prod approval gate enforced — surfaced as a per-project toggle in the
	 * Coolify integration drawer (see `integrations/components/coolify-section`).
	 */
	autoProdDeploy?: boolean;
	[key: string]: unknown;
}

/**
 * Built-in catalog of known secret-free MCP servers, mirrored from core's
 * `pipeline/mcp-catalog.ts` for the settings UI. Cross-app parity: when a new
 * secret-free catalog entry is added in core, add the matching descriptor here
 * so the toggle list surfaces it. Anything needing a token/API key is NOT a
 * catalog default (those flow through the integrations resolvers).
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

// cm:edge naming -> packages/core/src/pipeline/pipeline-config-schema.ts — the same four STAGE_NAMES keys, same order; a stage added there needs a row here or the screen renders its raw status
export const PIPELINE_STATUS_ROWS: ReadonlyArray<{ status: string; label: string }> = [
	{ status: "open", label: "Queued" },
	{ status: "in_progress", label: "Running" },
	{ status: "needs_info", label: "Needs a human" },
	{ status: "released", label: "Awaiting release" },
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

/**
 * Tool id -> a human label, for both shapes seen in `disallowedTools`/`allowedTools`:
 *   - `mcp__<server>__<rest>` (every forge MCP tool) -> server + a de-prefixed,
 *     space-cased rest. `mcp__forge__forge_projects_archive` -> "Projects archive".
 *   - a bare Claude Code builtin, PascalCase -> space-cased. `CronCreate` -> "Cron create".
 * `raw` is always kept so a caller can offer it via `title=`.
 */
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
		// cm:why a stage whose ONLY override is its runner pool must still render — otherwise pinning a stage to a box makes that stage vanish from the one screen an operator checks it on
		(sc.deviceIds?.length ?? 0) > 0
	);
}

/** Every `states[status]` that carries a permission-relevant override, in
 *  ladder order — a status outside `PIPELINE_STATUS_ROWS` still renders,
 *  labelled with its raw key, so a future `StageName` is never silently dropped. */
export function summarizeStageConfig(cfg: PipelineConfig): StagePermissionRow[] {
	const states = (cfg.states ?? {}) as Record<string, PipelineStateConfig>;
	const rows: StagePermissionRow[] = [];
	const seen = new Set<string>();

	for (const { status, label } of PIPELINE_STATUS_ROWS) {
		seen.add(status);
		const sc = states[status];
		if (sc && stageHasOverride(sc)) rows.push({ status, label, config: sc });
	}
	for (const [status, sc] of Object.entries(states)) {
		if (seen.has(status) || !stageHasOverride(sc)) continue;
		rows.push({ status, label: status, config: sc });
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

// cm:edge naming -> packages/core/src/db/schema.ts — `jobTypes`, mirrored so the jobType picker offers what `stateContextSchema` (a partialRecord over that enum) accepts; a value added there and not here is a jobType no operator can configure, and one removed there but left here 400s the save
export const STATE_CONTEXT_JOB_TYPES = [
	"triage",
	"clarify",
	"plan",
	"code",
	"review",
	"test",
	"staging",
	"release",
	"fix",
	"custom",
	"pm",
	"smoke",
	"release_batch",
	"reconcile",
	"verify_skill",
	"drive",
] as const;

// cm:edge naming -> packages/core/src/projects/state-context.ts — `budgetSchema` bounds; a cap raised there and not here refuses in the browser a value the server would have taken
export const BUDGET_PER_RUN_MAX = 1000;
export const BUDGET_PER_MONTH_MAX = 100_000;

export type BudgetAction = "warn" | "pause";
export interface StateContextBudget {
	perRunUsd?: number;
	perMonthUsd?: number;
	action?: BudgetAction;
}

/**
 * Reasons core would refuse a budget, or `[]` when it would take it. Its
 * `budgetSchema` is `.strict()` with all three keys REQUIRED, so a budget
 * carrying only `perRunUsd` is not a smaller budget — it is a 400.
 */
export function validateBudget(b: StateContextBudget): string[] {
	const errors: string[] = [];
	const present = [b.perRunUsd, b.perMonthUsd, b.action].filter((v) => v != null).length;
	if (present === 0) return errors;
	if (present < 3) errors.push("A budget needs all three of per-run, per-month and action.");
	if (b.perRunUsd != null && (b.perRunUsd < 0 || b.perRunUsd > BUDGET_PER_RUN_MAX)) {
		errors.push(`Per-run must be between 0 and ${BUDGET_PER_RUN_MAX}.`);
	}
	if (b.perMonthUsd != null && (b.perMonthUsd < 0 || b.perMonthUsd > BUDGET_PER_MONTH_MAX)) {
		errors.push(`Per-month must be between 0 and ${BUDGET_PER_MONTH_MAX}.`);
	}
	return errors;
}

// cm:guard the ONLY writer of a single stage. `statesConfigSchema` has no passthrough and the PATCH replaces `states` wholesale, so anything building a `states` map from less than the fetched one DELETES the stages it left out — spread cfg, spread cfg.states, spread the stage, override nothing else.
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
			"Per-stage spend caps. Distinct from the per-jobType budget below, which IS editable — two caps on one screen read as one, so this one stays with the API until the pair is designed together.",
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

// cm:edge contract -> packages/core/src/app-config/memory-model-routes.ts — the five states, the counters and the estimate keys are decided there and by memory/chunk-reindex.ts; this screen only draws them

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
