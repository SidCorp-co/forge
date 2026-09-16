// web-v2 feature module: integrations hub.
//
// Cutover-agnostic shapes (status cards, delivery rows, health result, provider
// config/secret inputs, confirm-live result, the role and stage enums) now live in
// @forge/contracts (ISS-400) so web + dev share ONE contract instead of local
// duplicates. They are re-exported here under the existing local names (aliased
// where the contract name differs) so import sites in api.ts / hooks.ts /
// components stay unchanged.
//
// Nothing provider-SHAPED belongs here. A provider's own read-shape lives beside its module under
// `providers/<provider>/config.ts`; the permissive union of every provider's config keys that used
// to sit in this file is exactly the duplication ISS-1071 collapsed.

import type {
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
  BindingRole,
  DeployStage,
  CoolifyConfigInput,
  CoolifyTargetInput,
  CoolifySecretsInput,
  EpodsystemConfigInput,
  EpodsystemSecretsInput,
  PostmanRegion,
  PostmanMode,
  SentryConfigInput,
  SentrySecretsInput,
  RocketchatConfigInput,
  RocketchatSecretsInput,
  GoogleConfigInput,
  GoogleSecretsInput,
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
  BindExistingConnectionRequest,
  ConnectionBindingsResponse,
  DeliveryRetryResponse,
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
 * What `POST .../integrations/github/connect` hands back. Nothing is persisted
 * yet: `state` is a signed claim that Forge asked for this App, redeemed once at
 * the manifest callback, and `manifest` is the App definition GitHub renders for
 * approval.
 */
/** One repository an installation of the App actually granted. `installationId`
 *  rides along because a binding needs both: the installation mints the token,
 *  the repository is what the project points at. */
export interface InstallationRepo {
  installationId: number;
  account: string;
  owner: string;
  repo: string;
  fullName: string;
}

export interface GitHubRepositoriesResponse {
  repositories: InstallationRepo[];
  truncated: boolean;
}

export interface GitHubConnectStart {
  postUrl: string;
  state: string;
  manifest: Record<string, unknown>;
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

/** ISS-925 — one Coolify application, as the deploy-target picker shows it. */
export interface CoolifyApplication {
	uuid: string;
	name: string | null;
	fqdn: string | null;
	gitRepository: string | null;
	gitBranch: string | null;
	gitCommitSha: string | null;
	status: string | null;
}

/** A bound deploy target resolved against what Coolify actually lists. */
export interface CoolifyTargetIdentity extends CoolifyApplication {
	targetId: string;
	label: string;
	/** `false` when Coolify does not list this uuid — a wrong binding, visible here. */
	found: boolean;
}

/** One Rocket.Chat room the bot is a member of (room picker source). */
export interface RocketchatRoom {
  rid: string;
  name: string;
  /** c = public channel, p = private group. */
  type: "c" | "p";
}

// cm:why both request shapes are re-exports and not local unions: the eight-arm create union and
// the six-arm patch union repeated the provider list a third and fourth time, so adding a provider
// was a breaking type change for every caller. The server resolves each provider's own schemas from
// its declaration and refuses an undeclared name by name.
export type {
  IntegrationBindingCreateInput as CreateIntegrationInput,
  IntegrationBindingUpdateInput as UpdateIntegrationInput,
  AgentAccess,
  AgentPathKind,
} from "@forge/contracts";
