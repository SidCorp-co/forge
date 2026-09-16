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


/** Re-exported, never re-declared — `INTEGRATION_PROVIDERS` in core is the list. */
import type { AgentPathKind } from '@forge/core/public';

export type {
  AgentPathKind,
  IntegrationCapabilities,
  IntegrationProvider,
} from '@forge/core/public';

/**
 * ISS-1071 — whether an agent working a project may use one of its integrations. Two values and
 * no more: this is a binary grant, and per-tool scoping within a provider is a different question
 * that this deliberately cannot express.
 */
export const AGENT_ACCESS_VALUES = ['none', 'all'] as const;
export type AgentAccess = (typeof AGENT_ACCESS_VALUES)[number];

/**
 * The deploy capability — which providers a binding may take `role: 'deploy'` on — lives in
 * `./deploy-capability.js` and is reached as `@forge/contracts/deploy-capability`, NOT through this
 * module or the barrel. This file imports `@forge/core/public` for its types, which a browser build
 * cannot resolve, so a runtime value placed here is unreachable from web-v2 at build time however
 * well it type-checks.
 */

/** `'user' | 'org'` — the connection owner namespace. */
export type IntegrationOwnerType = schema.IntegrationOwnerType;
/** `'deploy' | 'service'` — what a binding is FOR. */
export type BindingRole = schema.BindingRole;
/** `'preview' | 'live'` — the two environments, named for who is looking at them. */
export type DeployStage = schema.DeployStage;
/** `'outbound' | 'inbound'` — delivery direction. */
export type IntegrationDeliveryDirection = schema.IntegrationDeliveryDirection;
/** `'pending' | 'ok' | 'failed'` — delivery status. */
export type IntegrationDeliveryStatus = schema.IntegrationDeliveryStatus;


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
  role: BindingRole;
  /** Empty for `service`; one or both stages for `deploy`. */
  stages: DeployStage[];
  config: Record<string, unknown>;
  /** Raw binding-tier overrides (e.g. coolify resourceUuid/branch) — `config`
   *  is the merged connection+binding view; this distinguishes a per-project
   *  value from one inherited off the shared connection. */
  bindingConfig: Record<string, unknown>;
  /** ISS-558 — binding label. Empty string = default/unlabeled; non-empty = named
   *  extra storefront (epodsystem only). Always '' for non-epodsystem providers. */
  label: string;
  /** Both tiers must be on for the integration to resolve. Kept as the AND so
   *  every existing reader ("is this live?") is unchanged; the two flags below
   *  say WHICH tier is off, which a single collapsed boolean cannot. */
  active: boolean;
  /** Project tier — does THIS project opt in. The only tier a project admin's
   *  binding PATCH can write. */
  bindingActive: boolean;
  /** Credential tier — is the org-shared connection enabled at all. False here
   *  means no project can use it, and only an org owner/admin can flip it (via
   *  the connection route, not a binding PATCH). */
  connectionActive: boolean;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
  breakerOpenedAt: string | null;
  /** True when the connection stores an encrypted credential. */
  hasSecrets: boolean;
  /** True when the binding carries an inbound-webhook HMAC secret. */
  integrationSecretSet: boolean;
  /**
   * ISS-1071 — whether an agent working this project may use this integration. `none` is the
   * closed answer and the default; `all` grants every tool the provider's declared agent path
   * offers. This is the ONLY switch: it replaced a sentinel key in `pipelineConfig.mcpServers`
   * on a different settings tab that no connect surface could write.
   */
  agentAccess: AgentAccess;
  /**
   * The declared risk class of this provider's agent path, so a screen can say what the grant
   * means without knowing the provider: `none` renders no control at all, `core-mediated` means
   * Forge stays in the call path, `direct-mcp` means the credential is handed to the runner box.
   */
  agentPathKind: AgentPathKind;
  createdAt: string;
  updatedAt: string;
}


/**
 * Coarse card-status bucket for the composed status read model.
 * - `disabled`   — a binding/connection EXISTS but was switched off (distinct
 *                  from `not_configured`, which means nothing is set up).
 * - `unverified` — active binding whose connection has never been health-checked
 *                  (no signal ≠ degraded). ISS-429.
 */
export type IntegrationCardStatus =
  | 'connected'
  | 'attention'
  | 'error'
  | 'not_configured'
  | 'disabled'
  | 'unverified';

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


/**
 * Webhook/dispatch delivery row (`GET .../integrations/:id/deliveries`). Raw
 * `integration_deliveries` row with Date columns serialized to ISO strings.
 * Scoped by `bindingId` since the ISS-410 retirement of project_integrations.
 */
export interface IntegrationDeliveryRow {
  id: string;
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


/**
 * Result of the test-connection (`POST .../test`) call — an adapter `HealthCheckResult`.
 * `needs_reauth` (ISS-409 / F4) signals the stored credential was rejected and
 * the rotation fallback did not recover; a consumer (F3) prompts re-authorization.
 * It is surfaced verbatim on `lastHealthStatus`; `IntegrationCardStatus` stays a
 * 4-value coarse bucket (needs_reauth maps to `attention`).
 */
export interface IntegrationHealthResult {
  // cm:guard `needs_scope` is NOT a flavour of `needs_reauth` and must stay in this union — core's `HealthStatus` has carried it since ISS-924 and this contract did not, so a 403 arrived over the wire as a value no consumer's type admitted. One says replace the credential, the other says the credential is fine and its permissions are not (ISS-1036 restored the member).
  status: 'ok' | 'degraded' | 'error' | 'needs_reauth' | 'needs_scope';
  message?: string;
  /** Free-form provider diagnostics surfaced to operators in the test-connection UI. */
  diagnostics?: Record<string, unknown>;
}

/**
 * Result of `POST /integration-connections/:id/test` (ISS-435) — the
 * connection-scoped healthcheck used by the workspace directory drawer. Same
 * adapter result shape as the binding-scoped test; the server probes through a
 * representative active binding and replies 404 `NO_BINDING` when the
 * connection has no active binding to build a context from.
 */
export type ConnectionTestResult = IntegrationHealthResult;

/** Result of `POST .../confirm-prod-deploy`. `integrationId` stays the binding id. */
export interface ConfirmProdDeployResult {
  confirmed: boolean;
  runId: string | null;
  integrationId: string;
}


/** One Coolify deploy target (a single application UUID). `id` is server-assigned
 *  when omitted; a write replaces the whole `targets` array. */
export interface CoolifyTargetInput {
  id?: string;
  label: string;
  resourceUuid: string;
  /** Absolute URL of this application's health endpoint; absent = no post-deploy health gate. */
  // cm:edge contract -> packages/core/src/integrations/provider-schemas.ts — the zod target schema is the other half, and a form that sends a target without this key CLEARS a health gate an operator set, because a config PATCH replaces the whole `targets` array (ISS-971)
  healthUrl?: string;
}

/**
 * Coolify config. `baseUrl` is connection-tier (shared credential); `targets`
 * is binding-tier (per project+stage) and may list several applications
 * (e.g. a split backend + frontend) that deploy together.
 */
export interface CoolifyConfigInput {
  baseUrl: string;
  targets: CoolifyTargetInput[];
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

/**
 * One labelled Sentry target under a connection (ISS-526). A Forge project that
 * spans several Sentry projects (backend / frontend / mobile) records one target
 * per stack; `label` is the human name the agent disambiguates on, the optional
 * slugs scope which org/project a Sentry MCP call hits, `environment` is a free
 * display label, and `notes` is free-text guidance for the agent. All targets
 * share ONE host + auth token (the token already reads every project it can see).
 */
export interface SentryTargetInput {
  label: string;
  organizationSlug?: string;
  projectSlug?: string;
  environment?: string;
  notes?: string;
}

/**
 * Sentry non-secret config (`connection.config`). `host` is the Sentry instance
 * (self-hosted, e.g. `logs.canawan.com`, or SaaS `sentry.io`) without scheme;
 * `targets` is the labelled list of org/project the operator works against
 * (ISS-526). The legacy top-level `organizationSlug`/`projectSlug` (ISS-524) are
 * kept optional for back-compat reads of pre-ISS-526 connections. The `sntryu_`
 * auth token is the secret.
 */
export interface SentryConfigInput {
  host: string;
  targets?: SentryTargetInput[];
  /** @deprecated ISS-526 — superseded by `targets[]`; read-only back-compat. */
  organizationSlug?: string;
  /** @deprecated ISS-526 — superseded by `targets[]`; read-only back-compat. */
  projectSlug?: string;
}
export interface SentrySecretsInput {
  authToken: string;
}

/**
 * Rocket.Chat bot config (ISS-609). `serverUrl` is connection-tier (the org's
 * chat server); `rids` — the rooms the project's channel binding listens/replies
 * on (1..20) — is binding-tier, split server-side like Coolify's deploy targets.
 * The bot credential is a personal-access token + its user id (both secrets).
 */
export interface RocketchatConfigInput {
  serverUrl: string;
  rids?: string[];
}
export interface RocketchatSecretsInput {
  authToken: string;
  userId: string;
}
export interface GithubConfigInput {
  installationId?: number;
  owner?: string;
  repo?: string;
  /** GitHub Enterprise only; absent means api.github.com. */
  apiBaseUrl?: string;
}
/** All three come back from the app-manifest conversion; none is typed by hand. */
export interface GithubSecretsInput {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

/**
 * Google service-account config (ISS-1036). `clientEmail` and `projectId` are
 * READ BACK out of the stored key by the healthcheck, never typed;
 * `defaultSpreadsheetId` is binding-tier — one org account, one sheet per
 * project — and is the spreadsheet a `forge_google_sheets` call naming none
 * resolves to.
 */
export interface GoogleConfigInput {
  clientEmail?: string;
  projectId?: string;
  defaultSpreadsheetId?: string;
}

/** The service-account key file Google issued, whole and unmodified. */
export interface GoogleSecretsInput {
  serviceAccountJson: string;
}


/**
 * What a binding is FOR, and — for a `deploy` one — which stages it serves.
 *
 * Discriminated on `role`, so the three shapes the server refuses are not expressible here
 * either: a `service` binding carrying stages, a `deploy` binding carrying none, and a `deploy`
 * binding carrying an empty array. `stages?: never` is what makes the first one a compile error
 * rather than a 400 the caller discovers at runtime.
 *
 * The provider-capability rule — `role: 'deploy'` only where Forge has a deploy adapter — is NOT
 * expressed here and is not meant to be. It is a list that changes (`DEPLOY_CAPABLE_PROVIDERS` in
 * `@forge/contracts/deploy-capability`), and encoding it in this union would make adding an
 * adapter a breaking type change for every caller. The server refuses it by name instead.
 */
export type BindingShapeInput =
  | { role: 'service'; stages?: never }
  | { role: 'deploy'; stages: [DeployStage, ...DeployStage[]] };

/**
 * Body for `POST /:projectId/integrations` — discriminated on `provider`, and on `role` through
 * `BindingShapeInput`. Each arm validates its own config + secrets. `role` is required on every
 * arm and has NO default: the column it replaced defaulted on seven of eight providers precisely
 * because it demanded a value they had no meaning for.
 */
export type IntegrationBindingCreateInput = BindingShapeInput & {
  provider: IntegrationProvider;
  /** Validated against the provider's OWN declared schema, resolved from the registry. */
  config: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  /** Present = mint the credential as ORG-owned; absent = personal. */
  orgId?: string;
  /** ISS-558 — kebab label for a named extra binding, where the provider declares multiBinding. */
  label?: string;
  /** ISS-1071 — omitted means the closed answer, which is what a binding gets for not choosing. */
  agentAccess?: AgentAccess;
};

/** Body for `PATCH /:projectId/integrations/:id` — re-validated against the existing provider. */
export interface IntegrationBindingUpdateInput {
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  active?: boolean;
  /**
   * ISS-1071 — writing this on a `direct-mcp` provider takes the org-admin escalation that already
   * guards `active`, `secrets` and `config` on an org-owned connection, because the grant hands a
   * project's credential to a runner box. On a `core-mediated` provider it stays project-admin.
   */
  agentAccess?: AgentAccess;
}

/**
 * Body for `POST /integration-connections` — one envelope, not a per-provider union.
 *
 * ISS-1071: `config` and `secrets` are validated against the schemas the provider's own
 * declaration carries, resolved from the registry at request time. A union here repeated the
 * provider list a third time and made adding a provider a breaking type change for every caller;
 * the server names the rejected provider and the declared set instead.
 */
export interface ConnectionCreateInput {
  provider: IntegrationProvider;
  displayName?: string;
  config: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  /** Present = org-owned connection (requires org admin); absent = personal. */
  orgId?: string;
}

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
 * the credential); only the target project + role/stages. Caller must own the
 * connection and be an admin of the target project.
 */
export interface BindExistingConnectionRequest {
  projectId: string;
  role: BindingRole;
  /**
   * One or both stages for `deploy`; ABSENT for `service`. Not an empty array —
   * the server refuses a `stages` key on a service binding by name rather than
   * ignoring it, so a caller cannot believe it declared a stage that was dropped.
   */
  stages?: DeployStage[];
  /** Optional binding-tier overrides (coolify `targets[]`) so the shared
   *  connection deploys different apps in this project. Connection-tier keys
   *  (baseUrl) are dropped server-side. */
  config?: Record<string, unknown>;
  /** ISS-1071 — omitted means the closed answer. */
  agentAccess?: AgentAccess;
}


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
  /**
   * Immediate post-create/bind health probe (ISS-429) — create + bind-existing
   * run the adapter healthcheck right away so the integration starts from a
   * real state. `null` when the probe crashed at the transport layer.
   */
  health?: IntegrationHealthResult | null;
}

// cm:why these list routes answer with a bare `{ items }` object rather than the X-Total-Count + bare-array convention `ListResponse<T>` wraps, so the envelopes below declare `items` and nothing else

/**
 * Where one connection is actually used. The directory lists credentials that
 * are otherwise indistinguishable — several Coolify tokens differ only by the
 * projects behind them — so the list route carries usage and the cards tell
 * each other apart without a query per card.
 */
export interface ConnectionUsage {
  bindings: Array<{
    id: string;
    projectId: string;
    role: BindingRole;
  /** Empty for `service`; one or both stages for `deploy`. */
  stages: DeployStage[];
    label: string;
    active: boolean;
  }>;
}

/** A connection as the workspace directory reads it: the credential plus where it is used. */
export interface ConnectionDirectoryItem extends ConnectionSummary {
  usage: ConnectionUsage;
}

// cm:edge contract -> packages/core/src/integrations/connection-routes.ts — `usage` is carried by the LIST route alone; create/update answer with a bare ConnectionSummary, so widening ConnectionResponse to expect it would break both
/** List envelope for connections (`GET /integration-connections`). */
export interface ConnectionListResponse {
  items: ConnectionDirectoryItem[];
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
 * One entry of `GET /:projectId/integrations/mcp-preview` — exactly what the
 * dispatch-time resolver will inject into a runner's `mcpServers` for this
 * project (same builders + filters server-side, so the URL cannot drift).
 * `headers.Authorization` is redacted BY CONSTRUCTION — the real key is never
 * rendered into the preview.
 *
 * `reason`:
 * - `ok`             — this binding's entry WILL be injected on the next dispatch.
 * - `not_configured` — no binding exists for the provider (synthetic row).
 * - `disabled`       — binding or connection is switched off.
 * - `no_credential`  — active but the connection stores no secret.
 * - `shadowed`       — active with credential, but another binding of the same
 *                      provider wins the single `mcpServers.<provider>` slot.
 * - `not_granted`    — ISS-1071: active with credential and would otherwise
 *                      win the slot, but the binding's `agentAccess` is the
 *                      closed answer, so no agent on this project may use it.
 *                      A connected, healthy integration does NOT reach an agent
 *                      until somebody grants it — `lastHealthStatus` does not
 *                      gate the grant, so this is distinct from a credential
 *                      problem (`no_credential`) or a health/reauth issue.
 */
export interface McpServerPreviewEntry {
  provider: IntegrationProvider;
  serverName: string;
  /** Binding id backing this entry — null for the synthetic not_configured row. */
  bindingId: string | null;
  role: BindingRole | null;
  stages: DeployStage[];
  configured: boolean;
  active: boolean;
  willInject: boolean;
  reason: 'ok' | 'not_configured' | 'disabled' | 'no_credential' | 'shadowed' | 'not_granted';
  url: string | null;
  headers: Record<string, string> | null;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
}

/** Envelope for `GET /:projectId/integrations/mcp-preview`. */
export interface McpPreviewResponse {
  servers: McpServerPreviewEntry[];
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
