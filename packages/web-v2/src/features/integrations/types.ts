
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

/** Sentry config as the form reads it: `host` lives on the connection, `targets` on this project's
 *  integration (ISS-1380), so a project edits its own list whatever the shared connection holds. */
export interface SentryConfig {
  host: string;
  targets?: SentryTarget[];
}

/** One Sentry project a token can read, as the target picker lists it. */
export interface SentryProject {
  organizationSlug: string;
  slug: string;
  name: string | null;
  platform: string | null;
}

export interface SentryProjectsResponse {
  projects: SentryProject[];
  /** True where Sentry held more projects than the list carries. */
  truncated: boolean;
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
