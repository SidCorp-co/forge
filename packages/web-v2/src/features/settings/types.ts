// web-v2 feature module: settings (workspace-global, user-scoped). Shapes
// verified against `packages/core/src/auth/me.ts`, `pat/routes.ts`,
// `notifications/routes.ts`, and `auth/reauth.ts` for ISS-299.
export type ThemePref = "system" | "light" | "dark";
export type LanguagePref = "en" | "vi";

export interface Preferences {
  theme: ThemePref;
  language: LanguagePref;
  updatedAt: string | null;
}

export type PatScope = "read" | "write" | "admin";
export const PAT_SCOPES: PatScope[] = ["read", "write", "admin"];

export interface PatToken {
  id: string;
  name: string;
  prefix: string;
  scopes: PatScope[];
  projectIds: string[] | null;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
}

/** `POST /api/pat` echoes the row plus the one-time `plaintext` token. */
export interface PatTokenCreated extends PatToken {
  plaintext: string;
}

export interface CreatePatInput {
  name: string;
  scopes: PatScope[];
  expiresAt?: string | null;
}

export interface NotificationRow {
  id: string;
  userId: string;
  projectId: string | null;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  issueId: string | null;
  agentSessionId: string | null;
  createdAt: string;
}
