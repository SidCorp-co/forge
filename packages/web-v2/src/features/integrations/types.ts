
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
  projectSlug?: string;
  environment?: string;
}

export type { BindingSummary as IntegrationSummary } from "@forge/contracts";

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

export type {
  IntegrationBindingCreateInput as CreateIntegrationInput,
  IntegrationBindingUpdateInput as UpdateIntegrationInput,
  AgentAccess,
  AgentPathKind,
} from "@forge/contracts";
