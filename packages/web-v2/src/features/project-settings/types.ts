// web-v2 feature module: project-settings. Per-project configuration surface
// (ISS-316, web-v2 v1-parity epic ISS-313). Types match the exact `core` route
// responses — verified against `packages/core/src/projects/routes.ts`,
// `labels/routes.ts`, `projects/members-routes.ts`, and
// `pipeline/pipeline-config-schema.ts`. Do not guess field names.

// ── Project facts (ISS-521) — the per-project "rules" layer ─────────────────
// Mirrors `GET/PATCH /api/projects/:id/project-facts` in core routes.ts. The
// always-inject tier (projectFactsConfig) flags a fact for verbatim injection
// into every agent prompt.

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

/** A project label (`GET /api/projects/:id/labels`). */
export interface ProjectLabel {
	id: string;
	name: string;
	color: string | null;
}

/**
 * The 8 auto-stage toggle keys surfaced by the Pipeline tab — mirrors
 * `STEP_TOGGLE_KEYS` in `pipeline-config-schema.ts`. A stored toggle is either
 * a bare boolean or `{ enabled, runner?, model? }`; we surface only the boolean
 * and round-trip the full stored config so per-step overrides survive a save.
 */
export const STEP_TOGGLE_KEYS = [
	"autoTriage",
	"autoClarify",
	"autoPlan",
	"autoCode",
	"autoReview",
	"autoTest",
	"autoFix",
	"autoRelease",
] as const;

export type StepToggleKey = (typeof STEP_TOGGLE_KEYS)[number];

/**
 * One `states[<status>]` entry — mirrors `stageConfigSchema` in core
 * `pipeline/pipeline-config-schema.ts`. Only `enabled`/`mode` are edited by
 * this tab today (ISS-813 Phase 1 adds read-only display of the rest);
 * the index signature keeps every other key round-tripping on save.
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
	budget?: {
		perRunUsd?: number;
		perMonthUsd?: number;
		action?: "warn" | "pause";
	};
	sessionGroup?: string;
	skipComplexities?: string[];
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

/** One `agentConfig.stateContext[<jobType>]` entry — mirrors
 *  `stateContextEntrySchema` in core `projects/state-context.ts`. */
export interface StateContextEntry {
	modelOverride?: string | null;
	budget?: {
		perRunUsd?: number;
		perMonthUsd?: number;
		action?: "warn" | "pause";
	};
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

// ── UX Contract (ISS-574/578) — "choose, not write" rules + preset layer ───
// Mirrors `packages/core/src/db/schema.ts` (uxContractRules/uxFindings enums)
// and `packages/core/src/projects/ux-contract-presets.ts` (UxStackProfile).

export const UX_RULE_GROUPS = [
	"designSystem",
	"states",
	"flows",
	"a11y",
	"microcopy",
	"responsive",
] as const;
export type UxRuleGroup = (typeof UX_RULE_GROUPS)[number];

/** §1–6 display labels, in canonical contract order. */
export const UX_RULE_GROUP_LABELS: Record<UxRuleGroup, string> = {
	designSystem: "§1 Design system",
	states: "§2 States",
	flows: "§3 Flows & feedback",
	a11y: "§4 Accessibility",
	microcopy: "§5 Microcopy",
	responsive: "§6 Responsive",
};

export type UxRuleSeverity = "must" | "should";
export type UxRuleSource = "preset" | "detected" | "learned" | "manual";
export type UxRuleStatus = "active" | "proposed" | "retired";

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
] as const;
export type UxPreset = (typeof UX_PRESETS)[number];

export const UX_PRESET_LABELS: Record<UxPreset, string> = {
	"app-strict": "App (strict)",
	marketing: "Marketing site",
	"internal-tool": "Internal tool",
	custom: "Custom",
};

/** `GET /api/projects/:id/ux-contract-rules` row. */
export interface UxContractRule {
	id: string;
	projectId: string;
	group: UxRuleGroup;
	text: string;
	severity: UxRuleSeverity;
	source: UxRuleSource;
	status: UxRuleStatus;
	evidenceIssueIds: string[];
	orderIndex: number;
	createdAt: string;
	updatedAt: string;
}

/** `GET /api/projects/:id/ux-findings` row. */
export interface UxFinding {
	id: string;
	projectId: string;
	issueId: string;
	runId: string | null;
	stage: "review" | "verify-live";
	ruleId: string | null;
	kind:
		| "missing-state"
		| "a11y"
		| "microcopy"
		| "responsive"
		| "design-system"
		| "other";
	detail: string;
	severity: UxRuleSeverity;
	createdAt: string;
}

/** Structured knobs `apply-preset` accepts — mirrors `applyPresetSchema` in
 *  core `ux-contract-routes.ts`. Optional: the pilot applies preset defaults
 *  only (ISS-576 owns populating a real profile from auto-detect). */
export interface UxToggleSettings {
	emptySearchRequired: boolean;
	destructiveConfirm: boolean;
	a11yLevel: "basic" | "AA";
	mobileResponsive: boolean;
	optimisticUI: boolean;
}

/** Mirrors `UxStackProfile` in core `ux-contract-presets.ts`. Server-populated
 *  today (persisted by apply-preset); this tab renders it read-only. */
export interface UxStackProfile {
	projectLabel: string;
	bindingScope: string;
	knownGaps: string[];
	ruleOverrides?: Record<string, string>;
	designSystem?: {
		ownLibrary?: boolean;
		libraryName?: string | null;
		importRoot?: string | null;
		tokenSource?: string | null;
		toastMechanism?: string | null;
		i18n?: boolean;
		breakpoints?: string | null;
		statePrimitives?: string[];
	};
	preserveProse?: boolean;
}

/** `POST /api/projects/:id/ux-contract/apply-preset` body. */
export interface ApplyUxPresetInput {
	preset: UxPreset;
	toggles?: UxToggleSettings;
	profile?: UxStackProfile;
}

/** `POST /api/projects/:id/ux-contract/scan` response (202) — the chat session
 *  dispatched on a bound runner to collect + submit the stack snapshot. */
export interface UxScanDispatchResult {
	sessionId: string;
}

/** `PATCH /api/ux-contract-rules/:ruleId` body — partial, at least one field. */
export interface UxContractRulePatch {
	group?: UxRuleGroup;
	text?: string;
	severity?: UxRuleSeverity;
	source?: UxRuleSource;
	status?: UxRuleStatus;
	orderIndex?: number;
}

/**
 * Loosely-typed pipeline config. We only read/write the master `enabled` flag
 * and the 8 step toggles; everything else (`states`, `sessionGroups`, …) is
 * carried through opaquely so a PATCH never drops keys the FE doesn't surface.
 * `pipelineConfigPatchSchema` requires `states`, so we always send back the
 * full object we fetched.
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
	 * Named session groups: `group → the issue STATUSES whose jobs share one
	 * Claude CLI session (resumed via `--resume`). This is only a DECLARATION —
	 * the dispatcher reads continuity from each `states[<status>].sessionGroup`,
	 * so the editor must keep both in sync (see `session-groups-section.tsx`).
	 * Mirrors `sessionGroupsSchema` in core `pipeline/pipeline-config-schema.ts`.
	 */
	sessionGroups?: Record<string, string[]>;
	/** What to do when a session resume fails (device gone / prior failed). */
	onResumeFail?: "fresh" | "abort";
	/**
	 * The pipeline STATE whose exit stamps `issues.merged_at` — the column the
	 * `blocks`/`decomposes` dependency gate keys on. Must be a stage the pipeline
	 * actually transitions out of (the merge point), else dependents wedge.
	 * Mirrors `mergeStatesSchema` in core `pipeline/pipeline-config-schema.ts`.
	 */
	mergeStates?: { baseBranch?: string; productionBranch?: string };
	/**
	 * Per-project cap on simultaneously-active issues (default 1). Raise it to
	 * fan INDEPENDENT issues across the runner pool; dependent issues stay
	 * serialized by the dependency gates regardless. Range [1,20]. Mirrors
	 * `maxConcurrentIssues` in core `pipeline/pipeline-config-schema.ts`.
	 */
	maxConcurrentIssues?: number;
	/**
	 * ISS-606 — per-project intake gate. When enabled, EVERY create that would
	 * land at `open` (all channels, member-created included) parks at `draft`
	 * + label `intake` until a human approves via draft→open. `notify`
	 * (default true) pings the project owner on each gated arrival. Mirrors
	 * `intakeGate` in core `pipeline/pipeline-config-schema.ts`.
	 */
	intakeGate?: { enabled: boolean; notify?: boolean };
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

/**
 * Per-toggle metadata. `stage` is the SOURCE `issueStatus` the toggle dispatches
 * from — it's the key a skill is registered against (mirrors `PIPELINE_STEPS`
 * in core's `pipeline/registry.ts`). The Pipeline tab uses it to wire each row's
 * skill picker to the right stage, so a stage's toggle and its skill binding
 * live on one line instead of across two screens.
 */
export const STEP_TOGGLE_LABELS: Record<
	StepToggleKey,
	{ label: string; hint: string; stage: string; skillName: string }
> = {
	autoTriage: {
		label: "Auto triage",
		hint: "open → confirmed",
		stage: "open",
		skillName: "forge-triage",
	},
	autoClarify: {
		label: "Auto clarify",
		hint: "confirmed → clarified",
		stage: "confirmed",
		skillName: "forge-clarify",
	},
	autoPlan: {
		label: "Auto plan",
		hint: "clarified → approved",
		stage: "clarified",
		skillName: "forge-plan",
	},
	autoCode: {
		label: "Auto code",
		hint: "approved → developed",
		stage: "approved",
		skillName: "forge-code",
	},
	autoReview: {
		label: "Auto review",
		hint: "developed → testing",
		stage: "developed",
		skillName: "forge-review",
	},
	autoTest: {
		label: "Auto test",
		hint: "testing → tested",
		stage: "testing",
		skillName: "forge-test",
	},
	autoFix: {
		label: "Auto fix",
		hint: "reopen → developed",
		stage: "reopen",
		skillName: "forge-fix",
	},
	autoRelease: {
		label: "Auto release",
		hint: "released → closed",
		stage: "released",
		skillName: "forge-release",
	},
};

/** Normalize a stored toggle (boolean | { enabled }) to a plain boolean. */
export function toggleEnabled(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (value && typeof value === "object" && "enabled" in value) {
		return Boolean((value as { enabled?: unknown }).enabled);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Per-stage mode (Auto / Manual / Skip) — one selector replacing the old
// on/off toggle. Collapses the three backend knobs a stage actually depends on
// (the `autoX` toggle, `states[x].enabled`, `states[x].mode`) into one choice:
//   Auto   = pipeline auto-dispatches the stage's skill.
//            → autoX:true,  states[x] = { enabled:true,  mode:"auto"   }
//   Manual = stage waits for a human (gate); only a human fires/advances it.
//            → autoX:false, states[x] = { enabled:true,  mode:"manual" }
//   Skip   = stage is bypassed; the pipeline soft-skips to the next stage.
//            → autoX:false, states[x] = { enabled:false }
// Mirrors the dispatch gate in core `pipeline/orchestrator.ts` (a stage
// auto-runs only when cfg.enabled && states[x].enabled!==false &&
// states[x].mode!=="manual" && the autoX toggle is on).
// ---------------------------------------------------------------------------

export type StageMode = "auto" | "manual" | "skip";

type StageStateEntry = PipelineStateConfig;
type StagesMap = Record<string, StageStateEntry | undefined>;

function statesOf(cfg: PipelineConfig): StagesMap {
	return ((cfg.states as StagesMap | undefined) ?? {}) as StagesMap;
}

/**
 * Checkpoint statuses with NO pipeline skill (no `autoX` toggle, nothing to
 * auto-run). They only ever park (a human gate) or skip — never "Auto". Ordered
 * by where they sit in the lifecycle ladder so the Pipeline tab can interleave
 * them between the job stages. Mirrors the gaps in core `PIPELINE_STEPS`.
 */
export const CHECKPOINT_STAGES: {
	status: string;
	label: string;
	hint: string;
}[] = [
	// `tested` is the production approval GATE (manual by default): QA passed,
	// a human advances it to `released`. The former `pass`/`staging`/`deploying`
	// checkpoints are retired. See core `PIPELINE_STEPS` + `defaultStatesConfig`.
	{
		status: "tested",
		label: "Awaiting release",
		hint: "QA passed · approval gate before production",
	},
];

/** Ordered render ladder for the Pipeline tab: job stages interleaved with checkpoints. */
export const PIPELINE_LADDER: (
	| { kind: "job"; toggle: StepToggleKey }
	| { kind: "checkpoint"; status: string }
)[] = [
	{ kind: "job", toggle: "autoTriage" },
	{ kind: "job", toggle: "autoClarify" },
	{ kind: "job", toggle: "autoPlan" },
	{ kind: "job", toggle: "autoCode" },
	{ kind: "job", toggle: "autoReview" },
	{ kind: "job", toggle: "autoTest" },
	{ kind: "checkpoint", status: "tested" },
	{ kind: "job", toggle: "autoRelease" },
	{ kind: "job", toggle: "autoFix" },
];

/** Derive the 3-way mode for a JOB stage (has an autoX toggle + a skill). */
export function deriveJobStageMode(
	cfg: PipelineConfig,
	toggleKey: StepToggleKey,
	status: string,
): StageMode {
	const sc = statesOf(cfg)[status];
	if (sc?.enabled === false) return "skip";
	if (sc?.mode === "manual") return "manual";
	// `autoX` off parks the stage (waits for a human) — same effect as manual.
	if (!toggleEnabled(cfg[toggleKey])) return "manual";
	return "auto";
}

/** Derive the mode for a CHECKPOINT stage — only "manual" (park) or "skip".
 *  A checkpoint has no skill, so at runtime it either PARKS (`mode:"manual"`) or
 *  auto-skips past it. `enabled:false` is the authoritative "skip" signal and
 *  MUST win over a leftover `mode:"manual"` — the server's `classifySkippable`
 *  checks `enabled===false` first, and a Manual→Skip toggle merges `enabled:false`
 *  onto the old entry without clearing `mode`. Without this precedence the
 *  segment would stay stuck on "Manual" after picking Skip (no dirty → Save
 *  disabled). So: enabled:false ⇒ skip; else mode==="manual" ⇒ manual; else skip. */
export function deriveCheckpointMode(
	cfg: PipelineConfig,
	status: string,
): "manual" | "skip" {
	const sc = statesOf(cfg)[status];
	if (sc?.enabled === false) return "skip";
	return sc?.mode === "manual" ? "manual" : "skip";
}

/**
 * A secondary checkpoint (deploying/pass/staging) is surfaced ONLY when it's an
 * active manual gate (`mode:"manual"`). A skipped (`enabled:false`) or default
 * (auto) checkpoint carries no behaviour worth a row, so the Pipeline tab hides
 * it. `tested` is shown separately (always — the canonical pre-production gate),
 * so this only governs the secondary rows.
 */
export function isCheckpointGated(
	cfg: PipelineConfig,
	status: string,
): boolean {
	const sc = statesOf(cfg)[status];
	// A disabled (skipped) checkpoint is NOT an active gate, even if a stale
	// `mode:"manual"` lingers on the entry (enabled:false wins — see deriveCheckpointMode).
	return sc?.enabled !== false && sc?.mode === "manual";
}

/** The checkpoint always surfaced as the canonical pre-production gate. */
export const PRIMARY_CHECKPOINT = "tested";

/** Flip a toggle's `enabled` while preserving its object form ({enabled,runner,model}). */
function withToggleEnabled(existing: unknown, enabled: boolean): unknown {
	if (existing && typeof existing === "object")
		return { ...(existing as object), enabled };
	return enabled;
}

function mergeStateEntry(
	cfg: PipelineConfig,
	status: string,
	patch: StageStateEntry,
): StagesMap {
	const states = statesOf(cfg);
	return { ...states, [status]: { ...(states[status] ?? {}), ...patch } };
}

/** Apply a 3-way mode to a JOB stage → a new PipelineConfig (autoX + states[status]). */
export function applyJobStageMode(
	cfg: PipelineConfig,
	toggleKey: StepToggleKey,
	status: string,
	mode: StageMode,
): PipelineConfig {
	if (mode === "auto") {
		return {
			...cfg,
			[toggleKey]: withToggleEnabled(cfg[toggleKey], true),
			states: mergeStateEntry(cfg, status, { enabled: true, mode: "auto" }),
		};
	}
	if (mode === "manual") {
		return {
			...cfg,
			[toggleKey]: withToggleEnabled(cfg[toggleKey], false),
			states: mergeStateEntry(cfg, status, { enabled: true, mode: "manual" }),
		};
	}
	return {
		...cfg,
		[toggleKey]: withToggleEnabled(cfg[toggleKey], false),
		states: mergeStateEntry(cfg, status, { enabled: false }),
	};
}

/** Apply a mode to a CHECKPOINT stage (manual = park / skip = bypass). */
export function applyCheckpointMode(
	cfg: PipelineConfig,
	status: string,
	mode: "manual" | "skip",
): PipelineConfig {
	if (mode === "manual") {
		return {
			...cfg,
			states: mergeStateEntry(cfg, status, { enabled: true, mode: "manual" }),
		};
	}
	// cm:guard Skip must drop `mode` but keep every other key — deriveCheckpointMode reads enabled:false as authoritative, but a replace-the-whole-entry approach (the prior bug) silently deletes sibling keys like disallowedTools
	const { mode: _mode, ...rest } = statesOf(cfg)[status] ?? {};
	return {
		...cfg,
		states: { ...statesOf(cfg), [status]: { ...rest, enabled: false } },
	};
}

// ---------------------------------------------------------------------------
// Session groups (ISS-494)
// ---------------------------------------------------------------------------

/**
 * The pipeline STATUSES a session group can contain — the 8 statuses that
 * dispatch a job, labelled by the step that runs there. Members of a
 * `sessionGroups` entry MUST be `STAGE_NAMES` (issue statuses), NOT tracker
 * step-names: a group is a set of statuses whose jobs resume one Claude
 * session. Cross-app parity: mirrors the dispatchable rows of `PIPELINE_STEPS`
 * in core `pipeline/registry.ts` (status → jobType). Statuses with no job
 * (needs_info, tested, pass, staging, deploying) are intentionally omitted —
 * grouping them has no effect on session continuity.
 */
export const SESSION_GROUP_STAGES: ReadonlyArray<{
	status: string;
	label: string;
}> = [
	{ status: "open", label: "Triage" },
	{ status: "confirmed", label: "Clarify" },
	{ status: "clarified", label: "Plan" },
	{ status: "approved", label: "Code" },
	{ status: "developed", label: "Review" },
	{ status: "testing", label: "Test" },
	{ status: "reopen", label: "Fix" },
	{ status: "released", label: "Release" },
];

/** status → friendly step label (falls back to the raw status). */
export const SESSION_GROUP_STAGE_LABELS: Record<string, string> =
	Object.fromEntries(SESSION_GROUP_STAGES.map((s) => [s.status, s.label]));

export function sessionGroupStageLabel(status: string): string {
	return SESSION_GROUP_STAGE_LABELS[status] ?? status;
}

/**
 * One-click recommended grouping (AC#4): planning-phase steps share a session,
 * build-phase steps share another. `fix` (status `reopen`) is left ungrouped so
 * it never shares with `code` (status `approved`) — they branch off the same
 * base and racing them risks merge conflicts.
 */
export const SUGGESTED_SESSION_GROUPS: Record<string, string[]> = {
	planning: ["open", "confirmed", "clarified"],
	build: ["approved", "developed", "testing", "released"],
};

/** The two statuses whose jobs (code @ approved, fix @ reopen) must not share a
 *  group — used for the non-blocking merge-conflict warning. */
export const CODE_STATUS = "approved";
export const FIX_STATUS = "reopen";

/** `onResumeFail` choices surfaced in the editor. */
export const ON_RESUME_FAIL_OPTIONS: ReadonlyArray<{
	value: "fresh" | "abort";
	label: string;
	hint: string;
}> = [
	{
		value: "fresh",
		label: "Start fresh",
		hint: "Retry without --resume — a brand-new Claude session.",
	},
	{
		value: "abort",
		label: "Abort job",
		hint: "Fail the job so an operator can investigate.",
	},
];

const SESSION_GROUP_NAME_MAX = 64;

/**
 * Client-side mirror of core `sessionGroupsSchema` + the cross-field
 * `superRefine`: group names are 1–64 chars and unique; each group has ≥1
 * member; each status belongs to at most one group. Returns human-readable
 * error strings (empty array = valid). The backend stays the source of truth;
 * this just blocks an obviously-invalid PATCH before it round-trips.
 */
export function validateSessionGroups(
	groups: Record<string, string[]>,
): string[] {
	const errors: string[] = [];
	const names = Object.keys(groups);
	const seenNames = new Set<string>();
	const statusOwner = new Map<string, string>();

	for (const rawName of names) {
		const name = rawName.trim();
		if (name.length === 0) {
			errors.push("Group names cannot be empty.");
		} else if (name.length > SESSION_GROUP_NAME_MAX) {
			errors.push(
				`Group name "${name}" exceeds ${SESSION_GROUP_NAME_MAX} characters.`,
			);
		}
		if (seenNames.has(rawName)) {
			errors.push(`Duplicate group name "${rawName}".`);
		}
		seenNames.add(rawName);

		const members = groups[rawName] ?? [];
		if (members.length === 0) {
			errors.push(
				`Group "${rawName || "(unnamed)"}" needs at least one stage.`,
			);
		}
		for (const status of members) {
			const prior = statusOwner.get(status);
			if (prior && prior !== rawName) {
				errors.push(
					`Stage "${sessionGroupStageLabel(status)}" is in more than one group ("${prior}" and "${rawName}").`,
				);
			}
			statusOwner.set(status, rawName);
		}
	}

	return errors;
}

/** status → step label, for every `StageName` core accepts under `states`. */
// cm:edge naming -> packages/core/src/pipeline/pipeline-config-schema.ts — same 10 STAGE_NAMES keys, same order; add a stage there and add its row here
export const PIPELINE_STATUS_ROWS: ReadonlyArray<{
	status: string;
	label: string;
}> = [
	{ status: "open", label: "Triage" },
	{ status: "needs_info", label: "Needs info" },
	{ status: "confirmed", label: "Clarify" },
	{ status: "clarified", label: "Plan" },
	{ status: "approved", label: "Code" },
	{ status: "developed", label: "Review" },
	{ status: "testing", label: "Test" },
	{ status: "tested", label: "Awaiting release" },
	{ status: "reopen", label: "Fix" },
	{ status: "released", label: "Release" },
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
		if (server && rest.startsWith(`${server}_`))
			rest = rest.slice(server.length + 1);
		const words = rest.split("_").filter(Boolean);
		return {
			label: words.length > 0 ? toSentenceCase(words) : rest,
			server,
			raw,
		};
	}
	const words = splitPascalCase(raw);
	return {
		label: words.length > 0 ? toSentenceCase(words) : raw,
		server: null,
		raw,
	};
}

/** One stage row worth rendering on the Stage permissions section — carries
 *  any of allowedTools/disallowedTools/mcpServers/skipComplexities/sessionGroup. */
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
		(sc.skipComplexities?.length ?? 0) > 0 ||
		Boolean(sc.sessionGroup)
	);
}

/** Every `states[status]` that carries a permission-relevant override, in
 *  ladder order — a status outside `PIPELINE_STATUS_ROWS` still renders,
 *  labelled with its raw key, so a future `StageName` is never silently dropped. */
export function summarizeStageConfig(
	cfg: PipelineConfig,
): StagePermissionRow[] {
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
		const key = [...tools].sort().join(" ");
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
		return {
			status: row.status,
			isOutlier: missing.length > 0 || extra.length > 0,
			extra,
			missing,
		};
	});
}

/** Config keys the settings API accepts that this screen intentionally does
 *  not surface yet — driving the "configured elsewhere" note (invariant D:
 *  an unsurfaced key must state why, never go silent). */
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
			"Controls the Claude CLI's own approval mode — an operational lever, deferred to ISS-814.",
	},
	{
		key: "states[*].timeoutSeconds",
		reason: "Per-stage job timeout override — deferred to ISS-814.",
	},
	{
		key: "states[*].budget",
		reason:
			"Per-stage spend caps (perRunUsd/perMonthUsd) — deferred to ISS-814.",
	},
	{
		key: "states[*].systemPrompt",
		reason:
			"Raw prompt override (append/replace) — high blast radius, deferred pending a dedicated review surface.",
	},
	{
		key: "states[*].userPromptPolicy",
		reason:
			"Prompt field/truncation tuning — an advanced knob, deferred to ISS-814.",
	},
	{
		key: "maxResumeTokens / maxResumeReopenCycles",
		reason:
			"Session-resume budget guards (ISS-580) — project-level, not per-stage; deferred to ISS-814.",
	},
	{
		key: "recoveryMaxAttempts / recoveryWindowHours / recoveryByFailureKind",
		reason:
			"Absent from pipelineConfigSchema — the GET route's schema parse strips them before the response reaches the browser, so this screen genuinely cannot read them (core schema change, tracked on ISS-814).",
	},
];
