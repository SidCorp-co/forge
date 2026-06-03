// web-v2 feature module: project-settings. Per-project configuration surface
// (ISS-316, web-v2 v1-parity epic ISS-313). Types match the exact `core` route
// responses — verified against `packages/core/src/projects/routes.ts`,
// `labels/routes.ts`, `projects/members-routes.ts`, and
// `pipeline/pipeline-config-schema.ts`. Do not guess field names.

/** Patch body accepted by `PATCH /api/projects/:id` (basics + repo + testing). */
export interface ProjectUpdateInput {
  name?: string;
  description?: string | null;
  repoPath?: string | null;
  baseBranch?: string | null;
  productionBranch?: string | null;
  previewDeploy?: PreviewDeployConfig | null;
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
  role: "owner" | "admin" | "member";
  createdAt: string;
}

/** One row of `GET /api/projects/:id/members/invitations` — a pending invite. */
export interface ProjectInvitationRow {
  email: string;
  role: "admin" | "member";
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
  [key: string]: unknown;
}

export const STEP_TOGGLE_LABELS: Record<StepToggleKey, { label: string; hint: string }> = {
  autoTriage: { label: "Auto triage", hint: "open → confirmed" },
  autoClarify: { label: "Auto clarify", hint: "confirmed → clarified" },
  autoPlan: { label: "Auto plan", hint: "clarified → approved" },
  autoCode: { label: "Auto code", hint: "approved → developed" },
  autoReview: { label: "Auto review", hint: "developed → testing" },
  autoTest: { label: "Auto test", hint: "testing → released" },
  autoFix: { label: "Auto fix", hint: "reopen → developed" },
  autoRelease: { label: "Auto release", hint: "released → closed" },
};

/** Normalize a stored toggle (boolean | { enabled }) to a plain boolean. */
export function toggleEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "enabled" in value) {
    return Boolean((value as { enabled?: unknown }).enabled);
  }
  return false;
}
