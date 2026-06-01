// web-v2 feature module: integrations hub. Types verified against
// `GET /api/projects/:projectId/integrations/status` in
// `packages/core/src/integrations/routes.ts` (ISS-305).

export type CardStatus = "connected" | "attention" | "error" | "not_configured";

export interface StatusCard {
  key: string;
  label: string;
  status: CardStatus;
  detail: string;
  /** ISO timestamp of the last real sync/health-check, or null when none exists. */
  lastSyncAt: string | null;
  configured: boolean;
  meta?: Record<string, unknown>;
}

export interface IntegrationsStatus {
  cards: StatusCard[];
}

// === ISS-336 — Postman integration CRUD ===

export type PostmanRegion = "us" | "eu";
export type PostmanMode = "minimal" | "full";

/** Non-secret Postman write-target stored in `project_integrations.config`. */
export interface PostmanConfig {
  workspaceId?: string;
  workspaceName: string;
  collectionId?: string;
  region: PostmanRegion;
  mode: PostmanMode;
  environment?: string;
}

/** Summarized integration row — mirrors `summarize()` in core routes.ts. The
 *  API key is NEVER present here; `hasSecrets` only indicates one is stored. */
export interface IntegrationSummary {
  id: string;
  projectId: string;
  provider: string;
  environment: string;
  config: Record<string, unknown>;
  active: boolean;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
  breakerOpenedAt: string | null;
  hasSecrets: boolean;
  integrationSecretSet: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Body for creating a Postman integration. */
export interface CreatePostmanInput {
  config: PostmanConfig;
  apiKey: string;
}

/** Body for patching a Postman integration (all fields optional). */
export interface UpdatePostmanInput {
  config?: Partial<PostmanConfig>;
  apiKey?: string;
  active?: boolean;
}

/** Result of the test-connection (`POST .../test`) call — `HealthCheckResult`. */
export interface IntegrationTestResult {
  status: "ok" | "degraded" | "error";
  message?: string;
  diagnostics?: {
    user?: {
      id: number | string | null;
      username: string | null;
      email: string | null;
      fullName: string | null;
    };
    [k: string]: unknown;
  };
}
