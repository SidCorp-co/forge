// Hand-typed response wrappers. Core returns bare arrays for list endpoints
// with an `X-Total-Count` header; `apiClientList` in web-v2 reads that
// header and wraps the payload into `ListResponse<T>` for ergonomics.

import type { User } from './rows.js';

export interface ListResponse<T> {
  items: T[];
  totalCount: number;
}

// `GET /api/auth/me` — the canonical user row plus the auth-surface metadata
// the settings UI branches on: `hasPassword` decides between the password
// re-auth prompt and the SSO `reauth-start` redirect; `oauthProviders` lists
// the linked providers a password-less user can re-authenticate with.
export interface MeResponse extends User {
  lastFreshAuthAt: string | null;
  hasPassword: boolean;
  oauthProviders: string[];
}

// Login response from `POST /api/auth/local`. The access token is set as
// an httpOnly `forge_auth` cookie and ALSO returned in the body so native
// clients (Tauri) that prefer Bearer headers can store it. The refresh
// token rides an httpOnly cookie scoped to /api/auth — never returned in
// JSON, never visible to JavaScript.
export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
  };
  emailVerificationRequired: boolean;
}

export interface RegisterResponse {
  userId: string;
  email: string;
}

// Same shape as login: the new JWT comes back in the body (for Bearer
// callers) plus the auth cookie; the new refresh token rides the
// httpOnly refresh cookie.
export interface RefreshResponse {
  token: string;
}

export interface MeRunnerAssignment {
  projectId: string;
  runnerId: string;
  slug: string;
  baseBranch: string | null;
  repoPath: string | null;
  branch: string | null;
  status: string;
  /** `standard` (code repo) or `website` (storefront, git optional). */
  kind: string;
  /** Prose: how to bring this repo's workspace to a usable state. */
  workspaceSetup: string | null;
  /** The `master-policy` projectFact: the owner's standing instruction for this
   *  project's resident master, spliced into its standing brief (ISS-929). */
  masterPolicy: string | null;
}

export type MeRunnersResponse = MeRunnerAssignment[];

// Returned by `POST /api/projects/:id/runners` and
// `PATCH /api/projects/:id/runners/:runnerId`. Mirrors the runner row
// projection both endpoints return.
export interface BindRunnerResponse {
  id: string;
  projectId: string;
  deviceId: string | null;
  repoPath: string | null;
  branch: string | null;
  status: 'online' | 'offline' | 'draining' | 'disabled';
}

// Skill Studio 4 (ISS-278) — device skill sync. A skill file as stored in
// `skills.files[]`: relative path under the skill folder (`SKILL.md` is stored
// separately as `skillMd`; `references/foo.md`, `scripts/bar.sh`, … live here),
// with text kept utf8 (LF-normalised) and binaries base64-encoded.
export interface SkillFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

// One entry of the device skill manifest from
// `GET /api/devices/me/skills?projectId=` (device-token auth). `effectiveHash`
// is the server-computed `hashSkillBody(effectiveMd, files)` the runner echoes
// back as `installedHash` after seeding. `skillMd`/`files` are present only
// when the request passed `?includeFiles=1`.
export interface DeviceSkillManifestEntry {
  skillId: string;
  name: string;
  version: number;
  effectiveHash: string;
  skillMd?: string;
  files?: SkillFile[];
}

export interface DeviceSkillManifestResponse {
  skills: DeviceSkillManifestEntry[];
}

// Full body for one skill from
// `GET /api/devices/me/skills/:skillId/content?projectId=`.
export interface DeviceSkillContent {
  skillId: string;
  name: string;
  version: number;
  effectiveHash: string;
  skillMd: string;
  files: SkillFile[];
}

export interface DeviceSkillReportBody {
  skills: Array<{
    skillId: string;
    installedHash: string;
    installedVersion?: number;
    observedSha?: string;
    shadowedBy?: string;
  }>;
  pruned?: string[];
}

export type DeviceSkillStatusValue = 'synced' | 'outdated' | 'missing' | 'unknown' | 'shadowed' | 'stale';

// One row of the per-device skill freshness from
// `GET /api/projects/:projectId/devices/:deviceId/skills` (user-token auth,
// consumed by the Skill Studio 5 UI).
export interface DeviceSkillStatusEntry {
  skillId: string;
  name: string;
  effectiveHash: string;
  installedHash: string | null;
  installedVersion: number | null;
  syncedAt: string | null;
  observedSha: string | null;
  shadowedBy: string | null;
  status: DeviceSkillStatusValue;
}

export interface DeviceSkillStatusResponse {
  skills: DeviceSkillStatusEntry[];
}
