// Shared connection/binding REST contract surface (ISS-400, EPIC ISS-398).
//
// One typed contract for the integrations REST surface so web + dev consume it
// instead of local duplicates (CLAUDE.md conventions.cross-app-parity). Mirrors
// the merged cutover-A REST (ISS-399, `packages/core/src/integrations/routes.ts`):
//   - `summarizeBinding`  → BindingSummary    (project-facing; `id` is the binding id)
//   - `summarizeConnection` → ConnectionSummary (owner-facing credential)
//   - `StatusCard` / status route → IntegrationStatusCard / IntegrationsStatus
//   - raw `integration_deliveries` rows → IntegrationDeliveryRow
//   - adapter `healthcheck()` → IntegrationHealthResult
//   - connection/binding CRUD + test/rotate request + response envelopes
//
// Secret bytes are excluded BY CONSTRUCTION: every summary/response is a fresh
// interface listing only non-secret fields (`hasSecrets` / `integrationSecretSet`
// booleans signal presence), never `Omit<Row, 'secretsEnc'>`. Timestamps are
// `string` (ISO) because these are the JSON-serialized client shapes.

import type { IntegrationProvider, schema } from '@forge/core/public';

// === Enums — mirrored from the DB schema source of truth (no hand-copied unions) ===

/** `'coolify' | 'postman' | 'epodsystem'`. */
export type { IntegrationProvider, IntegrationCapabilities } from '@forge/core/public';

/** `'user' | 'org'` — the connection owner namespace. */
export type IntegrationOwnerType = schema.IntegrationOwnerType;
/** `'staging' | 'prod'` — the binding environment split. */
export type IntegrationEnvironment = schema.IntegrationEnvironment;
/** `'outbound' | 'inbound'` — delivery direction. */
export type IntegrationDeliveryDirection = schema.IntegrationDeliveryDirection;
/** `'pending' | 'ok' | 'failed'` — delivery status. */
export type IntegrationDeliveryStatus = schema.IntegrationDeliveryStatus;

// === Summaries (no secret bytes) ===

/**
 * Owner-facing connection summary — the credential, owned by a principal.
 * Projection of `summarizeConnection`; never echoes the encrypted secret bytes.
 */
export interface ConnectionSummary {
  id: string;
  ownerType: IntegrationOwnerType;
  ownerId: string;
  provider: IntegrationProvider;
  displayName: string | null;
  /** Connection-scoped non-secret config (e.g. coolify baseUrl, postman region). */
  config: Record<string, unknown>;
  active: boolean;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
  breakerOpenedAt: string | null;
  /** True when an encrypted credential is stored — the bytes are never returned. */
  hasSecrets: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Project-facing integration summary, projected from a binding + its owning
 * connection. `id` is the BINDING id (== old project_integration id for
 * backfilled rows); health/breaker + secret-presence come from the connection;
 * `config` is the effective overlay (connection.config + binding overrides).
 */
export interface BindingSummary {
  id: string;
  connectionId: string;
  projectId: string;
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
  config: Record<string, unknown>;
  active: boolean;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
  breakerOpenedAt: string | null;
  /** True when the connection stores an encrypted credential. */
  hasSecrets: boolean;
  /** True when the binding carries an inbound-webhook HMAC secret. */
  integrationSecretSet: boolean;
  createdAt: string;
  updatedAt: string;
}

// === Composed status card (read-only hub) ===

export type IntegrationCardStatus = 'connected' | 'attention' | 'error' | 'not_configured';

/** One card in the composed integrations-status read model (`GET .../integrations/status`). */
export interface IntegrationStatusCard {
  key: string;
  label: string;
  status: IntegrationCardStatus;
  detail: string;
  /** ISO timestamp of the last real sync/health-check, or null when none exists. */
  lastSyncAt: string | null;
  configured: boolean;
  meta?: Record<string, unknown>;
}

export interface IntegrationsStatus {
  cards: IntegrationStatusCard[];
}

// === Delivery audit row ===

/**
 * Webhook/dispatch delivery row (`GET .../integrations/:id/deliveries`). Raw
 * `integration_deliveries` row with Date columns serialized to ISO strings.
 * `projectIntegrationId` is null for post-cutover dispatches (binding-only).
 */
export interface IntegrationDeliveryRow {
  id: string;
  projectIntegrationId: string | null;
  bindingId: string | null;
  direction: IntegrationDeliveryDirection;
  eventName: string;
  status: IntegrationDeliveryStatus;
  requestId: string | null;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

// === Health / test-connection result ===

/** Result of the test-connection (`POST .../test`) call — an adapter `HealthCheckResult`. */
export interface IntegrationHealthResult {
  status: 'ok' | 'degraded' | 'error';
  message?: string;
  /** Free-form provider diagnostics surfaced to operators in the test-connection UI. */
  diagnostics?: Record<string, unknown>;
}

/** Result of `POST .../confirm-prod-deploy`. `integrationId` stays the binding id. */
export interface ConfirmProdDeployResult {
  confirmed: boolean;
  runId: string | null;
  integrationId: string;
}

// === Provider config / secret inputs ===

/** Coolify non-secret config (`connection.config`). */
export interface CoolifyConfigInput {
  baseUrl: string;
  resourceUuid: string;
  branch: string;
}
export interface CoolifySecretsInput {
  apiToken: string;
}

export type PostmanRegion = 'us' | 'eu';
export type PostmanMode = 'minimal' | 'full';

/** Postman non-secret write-target (`connection.config`). */
export interface PostmanConfigInput {
  workspaceId?: string;
  workspaceName: string;
  collectionId?: string;
  region: PostmanRegion;
  mode: PostmanMode;
}
export interface PostmanSecretsInput {
  apiKey: string;
}

/**
 * Epodsystem storefront config. The endpoint is fixed platform config (env),
 * NOT user input; store identity is filled by the healthcheck, so every field
 * is optional — the operator only supplies the `crmk_` key as the secret.
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

// === Request bodies ===

/**
 * Body for `POST /:projectId/integrations` — discriminated on `provider`. Each
 * arm validates its own config + secrets. `environment` is required for coolify
 * (staging/prod split); postman + epodsystem default to `prod` server-side, so
 * it is optional here.
 */
export type IntegrationBindingCreateInput =
  | {
      provider: 'coolify';
      environment: IntegrationEnvironment;
      config: CoolifyConfigInput;
      secrets: CoolifySecretsInput;
    }
  | {
      provider: 'postman';
      environment?: IntegrationEnvironment;
      config: PostmanConfigInput;
      secrets: PostmanSecretsInput;
    }
  | {
      provider: 'epodsystem';
      environment?: IntegrationEnvironment;
      config: EpodsystemConfigInput;
      secrets: EpodsystemSecretsInput;
    };

/** Body for `PATCH /:projectId/integrations/:id` — re-validated against the existing provider. */
export interface IntegrationBindingUpdateInput {
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  active?: boolean;
}

/**
 * Body for `POST /integration-connections` — discriminated on `provider`. A
 * connection is the credential, owned by a principal; `displayName` is optional.
 */
export type ConnectionCreateInput =
  | {
      provider: 'coolify';
      displayName?: string;
      config: CoolifyConfigInput;
      secrets: CoolifySecretsInput;
    }
  | {
      provider: 'postman';
      displayName?: string;
      config: PostmanConfigInput;
      secrets: PostmanSecretsInput;
    }
  | {
      provider: 'epodsystem';
      displayName?: string;
      config: EpodsystemConfigInput;
      secrets: EpodsystemSecretsInput;
    };

/** Body for `PATCH /integration-connections/:id` — re-validated against the existing provider. */
export interface ConnectionUpdateInput {
  displayName?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  active?: boolean;
}

/**
 * Body for `POST /integration-connections/:id/bindings` — bind an EXISTING
 * connection to a project+env. Carries NO secrets (the connection already holds
 * the credential); only the target project + environment. Caller must own the
 * connection and be an admin of the target project.
 */
export interface BindExistingConnectionRequest {
  projectId: string;
  environment: IntegrationEnvironment;
}

// === Response envelopes ===

/** `{ connection }` — connection list items, create (201) + update. */
export interface ConnectionResponse {
  connection: ConnectionSummary;
}

/**
 * `{ integration }` — binding create/update. Create + rotate-secret also return
 * the freshly minted inbound-webhook HMAC `integrationSecret` (shown once).
 */
export interface BindingResponse {
  integration: BindingSummary;
  integrationSecret?: string;
}

// These list routes return a bare `{ items }` object (not the X-Total-Count +
// bare-array convention `ListResponse<T>` wraps), so they declare `items` only.

/** List envelope for connections (`GET /integration-connections`). */
export interface ConnectionListResponse {
  items: ConnectionSummary[];
}
/** List envelope for project bindings (`GET /:projectId/integrations`). */
export interface BindingListResponse {
  items: BindingSummary[];
}
/** List envelope for delivery rows (`GET .../integrations/:id/deliveries`). */
export interface IntegrationDeliveryListResponse {
  items: IntegrationDeliveryRow[];
}

/** List envelope for a connection's bindings (`GET /integration-connections/:id/bindings`). */
export interface ConnectionBindingsResponse {
  items: BindingSummary[];
}

/**
 * Result of `POST .../deliveries/:deliveryId/retry`. The retry is asynchronous —
 * the route re-enqueues the outbound dispatch with a fresh `requestId` and the
 * worker/adapter records the new delivery row, so this returns the queued
 * request id (202) rather than a synchronous delivery summary.
 */
export interface DeliveryRetryResponse {
  requestId: string;
  queued: true;
}
