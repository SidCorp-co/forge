/** Re-exported, never re-declared — `INTEGRATION_PROVIDERS` in core is the list. */
import type { AgentPathKind, IntegrationProvider, schema } from '@forge/core/public';

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

/** `'user' | 'org'` — the connection owner namespace. */
export type IntegrationOwnerType = schema.IntegrationOwnerType;
/** `'deploy' | 'service' | 'source'` — what a binding is FOR. */
export type BindingRole = schema.BindingRole;
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
  /** Project tier — does THIS project opt in. Written by the binding document's
   *  `active` (and switched off by DELETE), which a project admin may do. */
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
  agentAccess: AgentAccess;
  /**
   * The declared risk class of this provider's agent path, so a screen can say what the grant
   * means without knowing the provider: `none` renders no control at all, `core-mediated` means
   * Forge stays in the call path, `direct-mcp` means the credential is handed to the runner box.
   */
  agentPathKind: AgentPathKind;
  /** The binding row's revision: what `DELETE /api/projects/:id/bindings/:bindingId` is sent as
   *  `baseRevision`, so a binding is disconnected whether or not it has a binding-v1 document. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

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

export interface IntegrationHealthResult {
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
  healthUrl?: string;
}

/**
 * Coolify config. `baseUrl` is connection-tier (shared credential); `targets`
 * is binding-tier (per project+stage) and may list several applications
 * (e.g. a split backend + frontend) that deploy together.
 */
export type CoolifyConfigInput = {
  baseUrl: string;
  targets: CoolifyTargetInput[];
};
export type CoolifySecretsInput = {
  apiToken: string;
};

export type PostmanRegion = 'us' | 'eu';
export type PostmanMode = 'minimal' | 'full';

/** Postman non-secret write-target (`connection.config`). */
export type PostmanConfigInput = {
  workspaceId?: string;
  workspaceName: string;
  collectionId?: string;
  region: PostmanRegion;
  mode: PostmanMode;
};
export type PostmanSecretsInput = {
  apiKey: string;
};

/**
 * Epodsystem storefront config. The endpoint is fixed platform config (env),
 * NOT user input; store identity is filled by the healthcheck, so every field
 * is optional — the operator only supplies the `crmk_` key as the secret.
 */
export type EpodsystemConfigInput = {
  storeSlug?: string;
  storeName?: string;
  themeId?: string;
  draftThemeId?: string;
  commerceEnabled?: boolean;
};
export type EpodsystemSecretsInput = {
  apiKey: string;
};

export interface SentryTargetInput {
  label: string;
  organizationSlug?: string;
  projectSlug?: string;
  environment?: string;
  notes?: string;
}

export type SentryConfigInput = {
  host: string;
  targets?: SentryTargetInput[];
};
export type SentrySecretsInput = {
  authToken: string;
};

/**
 * Rocket.Chat bot config (ISS-609). `serverUrl` is connection-tier (the org's
 * chat server); `rids` — the rooms the project's channel binding listens/replies
 * on (1..20) — is binding-tier, split server-side like Coolify's deploy targets.
 * The bot credential is a personal-access token + its user id (both secrets).
 */
export type RocketchatConfigInput = {
  serverUrl: string;
  rids?: string[];
};
export type RocketchatSecretsInput = {
  authToken: string;
  userId: string;
};
export type GithubConfigInput = {
  installationId?: number;
  owner?: string;
  repo?: string;
  /** GitHub Enterprise only; absent means api.github.com. */
  apiBaseUrl?: string;
};
/** All three come back from the app-manifest conversion; none is typed by hand. */
export type GithubSecretsInput = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
};
/** GitLab (ISS-50): `baseUrl` is connection-tier (absent means https://gitlab.com); the project path or id is binding-tier. */
export type GitlabConfigInput = {
  baseUrl?: string;
  projectPath?: string;
  projectId?: number;
};
/** A project or group access token with the `api` scope, typed by hand and never read back. */
export type GitlabSecretsInput = {
  token: string;
};

/**
 * Google service-account config (ISS-1036). `clientEmail` and `projectId` are
 * READ BACK out of the stored key by the healthcheck, never typed;
 * `defaultSpreadsheetId` is binding-tier — one org account, one sheet per
 * project — and is the spreadsheet a `forge_google_sheets` call naming none
 * resolves to.
 */
export type GoogleConfigInput = {
  clientEmail?: string;
  projectId?: string;
  defaultSpreadsheetId?: string;
};

/** The service-account key file Google issued, whole and unmodified. */
export type GoogleSecretsInput = {
  serviceAccountJson: string;
};

/**
 * Body for `PATCH /:projectId/integrations/:id` — the connection tier (config, secrets) and the
 * binding's own switch and instructions. Binding-tier config and `agentAccess` are a binding-v1
 * document's (`PUT /api/projects/:projectId/bindings/:bindingId`), and refused here by name.
 */
export interface IntegrationBindingUpdateInput {
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

export interface ConnectionCreateInput {
  provider: IntegrationProvider;
  displayName?: string;
  config: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  /** Present = org-owned connection (requires org admin); absent = personal. */
  orgId?: string;
}

export interface ConnectionUpdateInput {
  displayName?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  active?: boolean;
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
    label: string;
    active: boolean;
  }>;
}

/** A connection as the workspace directory reads it: the credential plus where it is used. */
export interface ConnectionDirectoryItem extends ConnectionSummary {
  usage: ConnectionUsage;
}

/** List envelope for connections (`GET /integration-connections`). */
export interface ConnectionListResponse {
  items: ConnectionDirectoryItem[];
}
/**
 * List envelope for project bindings (`GET /:projectId/integrations`).
 *
 * `bindings` and `items` carry the same rows; `items` is a compatibility alias for the `forge` CLI
 * and the runner, and goes once those readers name `bindings` (ISS-1191).
 */
export interface BindingListResponse {
  bindings: BindingSummary[];
  items: BindingSummary[];
}
/** List envelope for delivery rows (`GET .../integrations/:id/deliveries`). */
export interface IntegrationDeliveryListResponse {
  items: IntegrationDeliveryRow[];
}

/** A connection's bindings (`GET /integration-connections/:id/bindings`), keyed as {@link BindingListResponse}. */
export interface ConnectionBindingsResponse {
  bindings: BindingSummary[];
  items: BindingSummary[];
}

export type McpServerPreviewReason =
  | 'ok'
  | 'not_configured'
  | 'disabled'
  | 'no_credential'
  | 'shadowed'
  | 'not_granted'
  | 'not_resolved';

export interface McpServerPreviewEntry {
  provider: IntegrationProvider;
  serverName: string;
  /** Binding id backing this entry — null for the synthetic not_configured one. */
  bindingId: string | null;
  role: BindingRole | null;
  configured: boolean;
  active: boolean;
  willInject: boolean;
  reason: McpServerPreviewReason;
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
