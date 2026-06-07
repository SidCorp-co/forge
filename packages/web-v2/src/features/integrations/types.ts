// web-v2 feature module: integrations hub.
//
// Cutover-agnostic shapes (status cards, delivery rows, health result, provider
// config/secret inputs, confirm-prod result, environment enum) now live in
// @forge/contracts (ISS-400) so web + dev share ONE contract instead of local
// duplicates. They are re-exported here under the existing local names (aliased
// where the contract name differs) so import sites in api.ts / hooks.ts /
// components stay unchanged.

import type {
  CoolifyConfigInput,
  CoolifySecretsInput,
  EpodsystemConfigInput,
  EpodsystemSecretsInput,
  IntegrationHealthResult,
  PostmanMode,
  PostmanRegion,
} from "@forge/contracts";

export type {
  IntegrationCardStatus as CardStatus,
  IntegrationStatusCard as StatusCard,
  IntegrationsStatus,
  IntegrationDeliveryRow as IntegrationDelivery,
  ConfirmProdDeployResult,
  IntegrationEnvironment,
  CoolifyConfigInput,
  CoolifySecretsInput,
  EpodsystemConfigInput,
  EpodsystemSecretsInput,
  PostmanRegion,
  PostmanMode,
} from "@forge/contracts";

// === ISS-336 — Postman integration CRUD (legacy create/update bodies) ===

/** Non-secret Postman write-target stored in the connection `config`. */
export interface PostmanConfig {
  workspaceId?: string;
  workspaceName: string;
  collectionId?: string;
  region: PostmanRegion;
  mode: PostmanMode;
  environment?: string;
}

/**
 * Summarized integration row consumed by the current web-v2 UI. The merged
 * cutover-A REST (ISS-399) returns the project-facing `BindingSummary`
 * (`@forge/contracts`), which is a SUPERSET of this shape (it adds
 * `connectionId`). This local shape is intentionally kept until the UI/api/hooks
 * cutover onto `BindingSummary` + connection CRUD (ISS-401/C, ISS-402/D); the
 * API key is NEVER present here — `hasSecrets` only signals one is stored.
 */
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

/**
 * Result of the test-connection (`POST .../test`) call. Bases the cutover-
 * agnostic shape on the contract `IntegrationHealthResult` and narrows
 * `diagnostics` to the Postman user fields the UI renders.
 */
export interface IntegrationTestResult extends IntegrationHealthResult {
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

/**
 * Permissive read-shape for a provider-specific `config` jsonb. Consumers
 * narrow by the row's `provider`; every field is optional so both the Coolify
 * and Epodsystem sections read it without per-provider casts. UI-local helper,
 * not a wire contract.
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
  environment?: "staging" | "prod";
}

/** Discriminated create body for the generic `POST .../integrations`. */
export type CreateIntegrationInput =
  | {
      provider: "coolify";
      environment: "staging" | "prod";
      config: CoolifyConfigInput;
      secrets: CoolifySecretsInput;
    }
  | {
      provider: "epodsystem";
      environment?: "staging" | "prod";
      config: EpodsystemConfigInput;
      secrets: EpodsystemSecretsInput;
    };

/** Partial patch for `PATCH .../integrations/:id`. */
export interface UpdateIntegrationInput {
  config?: Partial<CoolifyConfigInput> & Partial<EpodsystemConfigInput>;
  secrets?: Partial<CoolifySecretsInput> & Partial<EpodsystemSecretsInput>;
  active?: boolean;
}
