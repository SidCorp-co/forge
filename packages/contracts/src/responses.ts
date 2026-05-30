// Hand-typed response wrappers. Core returns bare arrays for list endpoints
// with an `X-Total-Count` header; `apiClientList` in `packages/web` reads that
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
