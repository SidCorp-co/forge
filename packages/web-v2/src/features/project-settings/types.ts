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
