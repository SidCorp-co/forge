// Hand-typed response wrappers. Core returns bare arrays for list endpoints
// with an `X-Total-Count` header; `apiClientList` in web-v2 reads that
// header and wraps the payload into `ListResponse<T>` for ergonomics.

export interface ListResponse<T> {
  items: T[];
  totalCount: number;
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

// ISS-271 — one entry per (device × project) runner assignment, returned by
// `GET /api/devices/me/runners` (device-token auth). The runner daemon uses
// `repoPath`/`branch` as the source of truth for the working dir, falling back
// to local config.toml only when the server has no path yet. `slug` lets the
// CLI resolve a project from its slug without hand-typing the project id.
export interface MeRunnerAssignment {
  projectId: string;
  runnerId: string;
  slug: string;
  baseBranch: string | null;
  repoPath: string | null;
  branch: string | null;
  status: string;
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

// Body for `POST /api/devices/me/skills/report?projectId=` — the runner reports
// the hash it actually installed for each seeded skill.
export interface DeviceSkillReportBody {
  skills: Array<{
    skillId: string;
    installedHash: string;
    installedVersion?: number;
  }>;
}

export type DeviceSkillStatusValue = 'synced' | 'outdated' | 'missing';

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
  status: DeviceSkillStatusValue;
}

export interface DeviceSkillStatusResponse {
  skills: DeviceSkillStatusEntry[];
}
