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

// === ISS-395 — Coolify + Epodsystem integration CRUD (ported from v1) ===
// The backend already supports all three providers; these types mirror v1
// `packages/web/src/features/integrations/types.ts`. Provider config is
// core-internal (not in @forge/contracts), so it is declared locally here.

export type IntegrationEnvironment = "staging" | "prod";

/** Coolify non-secret config (`project_integrations.config`). */
export interface CoolifyConfigInput {
  baseUrl: string;
  resourceUuid: string;
  branch: string;
}

export interface CoolifySecretsInput {
  apiToken: string;
}

/**
 * ISS-387 — Epodsystem storefront. One store per project; the `crmk_` key is
 * the only secret. The endpoint is fixed platform config (EPODSYSTEM_ENDPOINT
 * env), NOT user input. Store identity is filled by the test healthcheck, so
 * every config field is optional.
 */
export interface EpodsystemConfigInput {
  storeSlug?: string;
  storeName?: string;
  themeId?: string;
  draftThemeId?: string;
  commerceEnabled?: boolean;
}

export interface EpodsystemSecretsInput {
  apiKey: string;
}

/**
 * Permissive read-shape for a provider-specific `config` jsonb. Consumers
 * narrow by the row's `provider`; every field is optional so both the Coolify
 * and Epodsystem sections read it without per-provider casts.
 */
export interface ProviderConfig {
  // coolify
  baseUrl?: string;
  resourceUuid?: string;
  branch?: string;
  // epodsystem
  orgId?: string;
  scopes?: string[];
  storeId?: string;
  storeSlug?: string;
  storeName?: string;
  themeId?: string;
  themeName?: string;
  draftThemeId?: string;
  commerceEnabled?: boolean;
  domain?: string;
  environment?: IntegrationEnvironment;
}

/** Discriminated create body for the generic `POST .../integrations`. */
export type CreateIntegrationInput =
  | {
      provider: "coolify";
      environment: IntegrationEnvironment;
      config: CoolifyConfigInput;
      secrets: CoolifySecretsInput;
    }
  | {
      provider: "epodsystem";
      environment?: IntegrationEnvironment;
      config: EpodsystemConfigInput;
      secrets: EpodsystemSecretsInput;
    };

/** Partial patch for `PATCH .../integrations/:id`. */
export interface UpdateIntegrationInput {
  config?: Partial<CoolifyConfigInput> & Partial<EpodsystemConfigInput>;
  secrets?: Partial<CoolifySecretsInput> & Partial<EpodsystemSecretsInput>;
  active?: boolean;
}

/** Result of `POST .../confirm-prod-deploy`. */
export interface ConfirmProdDeployResult {
  confirmed: boolean;
  runId: string | null;
  integrationId: string;
}

/** Webhook delivery row (`GET .../deliveries`). */
export interface IntegrationDelivery {
  id: string;
  projectIntegrationId: string;
  direction: "outbound" | "inbound";
  eventName: string;
  status: "pending" | "ok" | "failed";
  requestId: string | null;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}
