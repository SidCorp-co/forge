// web-v2 feature module: project-settings. Per-project configuration surface
// (ISS-316, web-v2 v1-parity epic ISS-313). Types match the exact `core` route
// responses — verified against `packages/core/src/projects/routes.ts`,
// `labels/routes.ts`, `projects/members-routes.ts`, and
// `pipeline/pipeline-config-schema.ts`. Do not guess field names.

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
    spec: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"], env: {} },
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
    hint: "testing → released",
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

type StageStateEntry = { enabled?: boolean; mode?: "auto" | "manual"; [k: string]: unknown };
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
export const CHECKPOINT_STAGES: { status: string; label: string; hint: string }[] = [
  { status: "deploying", label: "Deploy", hint: "developed → testing · checkpoint" },
  { status: "tested", label: "Tested", hint: "testing → pass · checkpoint" },
  { status: "pass", label: "Pass", hint: "tested → staging · checkpoint" },
  { status: "staging", label: "Staging / preview", hint: "pass → released · checkpoint" },
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
  { kind: "checkpoint", status: "deploying" },
  { kind: "job", toggle: "autoTest" },
  { kind: "checkpoint", status: "tested" },
  { kind: "checkpoint", status: "pass" },
  { kind: "checkpoint", status: "staging" },
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

/** Derive the mode for a CHECKPOINT stage — only "manual" (park) or "skip". */
export function deriveCheckpointMode(cfg: PipelineConfig, status: string): "manual" | "skip" {
  return statesOf(cfg)[status]?.enabled === false ? "skip" : "manual";
}

/**
 * A legacy checkpoint (deploying/tested/pass) is surfaced ONLY when it's an
 * active manual gate (`mode:"manual"`) — e.g. dodgeprint's `tested`. A skipped
 * (`enabled:false`) or default `{enabled:true,mode:"auto"}` checkpoint carries no
 * behaviour worth a row, so the Pipeline tab hides it. `staging` is shown
 * separately (always — the canonical pre-production gate), so this only governs
 * the legacy rows.
 */
export function isCheckpointGated(cfg: PipelineConfig, status: string): boolean {
  return statesOf(cfg)[status]?.mode === "manual";
}

/** The checkpoint always surfaced as the canonical pre-production gate. */
export const PRIMARY_CHECKPOINT = "staging";

/** Flip a toggle's `enabled` while preserving its object form ({enabled,runner,model}). */
function withToggleEnabled(existing: unknown, enabled: boolean): unknown {
  if (existing && typeof existing === "object") return { ...(existing as object), enabled };
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
  return {
    ...cfg,
    states:
      mode === "manual"
        ? mergeStateEntry(cfg, status, { enabled: true, mode: "manual" })
        : mergeStateEntry(cfg, status, { enabled: false }),
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
export const SESSION_GROUP_STAGES: ReadonlyArray<{ status: string; label: string }> = [
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
export const SESSION_GROUP_STAGE_LABELS: Record<string, string> = Object.fromEntries(
  SESSION_GROUP_STAGES.map((s) => [s.status, s.label]),
);

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
export const ON_RESUME_FAIL_OPTIONS: ReadonlyArray<{ value: "fresh" | "abort"; label: string; hint: string }> = [
  { value: "fresh", label: "Start fresh", hint: "Retry without --resume — a brand-new Claude session." },
  { value: "abort", label: "Abort job", hint: "Fail the job so an operator can investigate." },
];

const SESSION_GROUP_NAME_MAX = 64;

/**
 * Client-side mirror of core `sessionGroupsSchema` + the cross-field
 * `superRefine`: group names are 1–64 chars and unique; each group has ≥1
 * member; each status belongs to at most one group. Returns human-readable
 * error strings (empty array = valid). The backend stays the source of truth;
 * this just blocks an obviously-invalid PATCH before it round-trips.
 */
export function validateSessionGroups(groups: Record<string, string[]>): string[] {
  const errors: string[] = [];
  const names = Object.keys(groups);
  const seenNames = new Set<string>();
  const statusOwner = new Map<string, string>();

  for (const rawName of names) {
    const name = rawName.trim();
    if (name.length === 0) {
      errors.push("Group names cannot be empty.");
    } else if (name.length > SESSION_GROUP_NAME_MAX) {
      errors.push(`Group name "${name}" exceeds ${SESSION_GROUP_NAME_MAX} characters.`);
    }
    if (seenNames.has(rawName)) {
      errors.push(`Duplicate group name "${rawName}".`);
    }
    seenNames.add(rawName);

    const members = groups[rawName] ?? [];
    if (members.length === 0) {
      errors.push(`Group "${rawName || "(unnamed)"}" needs at least one stage.`);
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
