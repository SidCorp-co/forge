// Hand-typed response wrappers. Core returns bare arrays for list endpoints
// with an `X-Total-Count` header; `apiClientList` in web-v2 reads that
// header and wraps the payload into `ListResponse<T>` for ergonomics.

import type { User } from './rows.js';

export interface ListResponse<T> {
  items: T[];
  totalCount: number;
}

export interface MeResponse extends User {
  lastFreshAuthAt: string | null;
  hasPassword: boolean;
  oauthProviders: string[];
}

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

export interface SkillFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

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

export type DeviceSkillStatusValue =
  | 'synced'
  | 'outdated'
  | 'missing'
  | 'unknown'
  | 'shadowed'
  | 'stale';

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
