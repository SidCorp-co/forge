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
  CoolifyTargetInput,
  EpodsystemConfigInput,
  EpodsystemSecretsInput,
  IntegrationHealthResult,
  PostmanConfigInput,
  PostmanMode,
  PostmanRegion,
  PostmanSecretsInput,
  SentryConfigInput,
  SentrySecretsInput,
} from "@forge/contracts";

export type {
  IntegrationCardStatus as CardStatus,
  IntegrationStatusCard as StatusCard,
  IntegrationsStatus,
  IntegrationDeliveryRow as IntegrationDelivery,
  ConfirmProdDeployResult,
  IntegrationEnvironment,
  CoolifyConfigInput,
  CoolifyTargetInput,
  CoolifySecretsInput,
  EpodsystemConfigInput,
  EpodsystemSecretsInput,
  PostmanRegion,
  PostmanMode,
  SentryConfigInput,
  SentrySecretsInput,
  // === ISS-401/C — connection/binding cutover ===
  // The project-facing binding summary + the owner-facing connection summary,
  // plus the connection CRUD request/response envelopes. All exclude secret
  // bytes by construction (only `hasSecrets`/`integrationSecretSet` booleans).
  BindingSummary,
  ConnectionSummary,
  ConnectionCreateInput,
  ConnectionUpdateInput,
  ConnectionResponse,
  ConnectionListResponse,
  BindingListResponse,
  // === ISS-408 / F3 — share-existing-connection + delivery-retry ===
  BindExistingConnectionRequest,
  ConnectionBindingsResponse,
  DeliveryRetryResponse,
  // === ISS-429 — MCP injection preview ===
  McpServerPreviewEntry,
  McpPreviewResponse,
} from "@forge/contracts";

// === ISS-336 — Postman integration config shape ===

/** Non-secret Postman write-target stored in the connection `config`. */
export interface PostmanConfig {
  workspaceId?: string;
  workspaceName: string;
  collectionId?: string;
  region: PostmanRegion;
  mode: PostmanMode;
  environment?: string;
}

// === ISS-524 / ISS-526 — Sentry integration config shape ===

/** One labelled Sentry target under the connection (ISS-526). */
export interface SentryTarget {
  label: string;
  organizationSlug?: string;
  projectSlug?: string;
  environment?: string;
  notes?: string;
}

/** Non-secret Sentry config stored in the connection `config`. `targets[]` is
 *  the labelled list (ISS-526); the top-level slugs are legacy back-compat. */
export interface SentryConfig {
  host: string;
  targets?: SentryTarget[];
  /** @deprecated ISS-526 — superseded by `targets[]`; read-only back-compat. */
  organizationSlug?: string;
  /** @deprecated ISS-526 — superseded by `targets[]`; read-only back-compat. */
  projectSlug?: string;
  environment?: string;
}

/**
 * Project-facing integration row consumed by the web-v2 UI. ISS-401/C cuts this
 * over to the contracts `BindingSummary` returned by the merged cutover-A REST
 * (ISS-399): it is a superset of the old local shape (adds `connectionId`). The
 * alias keeps every import site (`api.ts`/`hooks.ts`/components) unchanged. No
 * secret bytes are present — `hasSecrets`/`integrationSecretSet` only signal one
 * is stored.
 */
export type { BindingSummary as IntegrationSummary } from "@forge/contracts";

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
  targets?: CoolifyTargetInput[];
  // postman
  workspaceId?: string;
  workspaceName?: string;
  collectionId?: string;
  region?: PostmanRegion;
  mode?: PostmanMode;
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
  // sentry
  host?: string;
  organizationSlug?: string;
  projectSlug?: string;
  environment?: "staging" | "prod";
}

/** Discriminated create body for the generic `POST .../integrations`. */
export type CreateIntegrationInput =
  | {
      provider: "coolify";
      environment: "staging" | "prod";
      config: CoolifyConfigInput;
      secrets: CoolifySecretsInput;
      /** Present = org-owned credential (project's own org, org admin only). */
      orgId?: string;
    }
  | {
      provider: "epodsystem";
      environment?: "staging" | "prod";
      config: EpodsystemConfigInput;
      secrets: EpodsystemSecretsInput;
      orgId?: string;
    }
  | {
      provider: "postman";
      environment?: "staging" | "prod";
      config: PostmanConfigInput;
      secrets: PostmanSecretsInput;
      orgId?: string;
    }
  | {
      provider: "sentry";
      environment?: "staging" | "prod";
      config: SentryConfigInput;
      secrets: SentrySecretsInput;
      orgId?: string;
    };

/**
 * Partial patch for `PATCH .../integrations/:id`. `config`/`secrets` are a UNION
 * over the providers (one patch targets ONE provider): an intersection would
 * require a value to satisfy every provider at once, which is impossible now
 * that both Coolify and Sentry carry their own incompatible `targets[]` shape
 * (ISS-526). The server re-validates against the binding's actual provider.
 */
export interface UpdateIntegrationInput {
  config?:
    | Partial<CoolifyConfigInput>
    | Partial<EpodsystemConfigInput>
    | Partial<PostmanConfigInput>
    | Partial<SentryConfigInput>;
  secrets?:
    | Partial<CoolifySecretsInput>
    | Partial<EpodsystemSecretsInput>
    | Partial<PostmanSecretsInput>
    | Partial<SentrySecretsInput>;
  active?: boolean;
}
