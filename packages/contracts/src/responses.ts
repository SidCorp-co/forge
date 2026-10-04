// Hand-typed response wrappers. Core returns bare arrays for list endpoints
// with an `X-Total-Count` header; `apiClientList` in web-v2 reads that
// header and wraps the payload into `ListResponse<T>` for ergonomics.

import type { User } from './rows.js';

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

// Returned by `POST /api/projects/:id/runners` and
// `PATCH /api/projects/:id/runners/:runnerId`. Mirrors the runner row
// projection both endpoints return.
// Full body for one skill from
// `GET /api/devices/me/skills/:skillId/content?projectId=`.
