
import type { IntegrationHealthResult } from "@forge/contracts/integrations";

export type { IntegrationCardStatus as CardStatus, IntegrationStatusCard as StatusCard, IntegrationsStatus, IntegrationDeliveryRow as IntegrationDelivery, ConfirmProdDeployResult, BindingRole, CoolifyConfigInput, CoolifyTargetInput, CoolifySecretsInput, EpodsystemConfigInput, EpodsystemSecretsInput, SentryConfigInput, SentrySecretsInput, RocketchatConfigInput, RocketchatSecretsInput, BindingSummary, ConnectionSummary, ConnectionCreateInput, ConnectionCreateResponse, ConnectionBindingItem, ConnectionBindingWritten, ConnectionUpdateInput, ConnectionResponse, ConnectionListResponse, BindingListResponse, ConnectionBindingsResponse, McpServerPreviewEntry, McpPreviewResponse } from "@forge/contracts/integrations";

// === ISS-524 / ISS-526 — Sentry integration config shape ===

/** One labelled Sentry target under the connection (ISS-526). */
export interface SentryTarget {
  label: string;
  organizationSlug?: string;
  projectSlug?: string;
  environment?: string;
  notes?: string;
}

/** Non-secret Sentry config stored in the connection `config`: the host and its labelled targets (ISS-526). */
export interface SentryConfig {
  host: string;
  targets?: SentryTarget[];
}

export type { BindingSummary as IntegrationSummary } from "@forge/contracts/integrations";

interface InstallationRepo {
  installationId: number;
  account: string;
  owner: string;
  repo: string;
  fullName: string;
}

/** A binding-v1 target as `bindings[].target` takes it. */
export type BindingTarget = Record<string, unknown> & { provider: string };

/** The target a project is offered pre-ticked, or the candidates it is never guessed between. */
export type TargetSuggestion =
  | { projectId: string; by: "repository" | "slug" | "name"; target: BindingTarget }
  | { projectId: string; by: "ambiguous"; candidates: BindingTarget[] };

/** `GET /integration-connections/:id/targets`: binding-v1 targets a `bindings[].target` takes as they stand. */
export interface ConnectionTargetsResponse {
  targets: BindingTarget[];
  truncated: boolean;
  /** Where the provider matches targets to projects: one entry per unbound project the caller administers that matched. */
  suggestedFor?: TargetSuggestion[];
}

/** `GET /integration-connections/:id/github-app`: a GitHub App connection as its row reads it. */
export interface GitHubAppRow {
  connectionId: string;
  instance: boolean;
  slug: string | null;
  owner: string | null;
  visibility: "public" | "private" | "unknown";
  makePublicUrl: string | null;
  completePath: string | null;
  installations: Array<{
    installationId: number;
    account: string;
    accountType: string;
    state: "active" | "suspended" | "gone";
    used: boolean;
    settingsUrl: string;
  }>;
}

export interface GitHubRepositoriesResponse {
  repositories: InstallationRepo[];
  truncated: boolean;
}

/** Where Connect GitHub sends the browser: the instance App's install page, the manifest that makes it, or the App to complete. */
export type GitHubConnectStart =
  | { kind: "install"; installUrl: string }
  | { kind: "manifest"; postUrl: string; state: string; manifest: Record<string, unknown> }
  /** An App made before the instance had one: an operator completes it, never makes a second. */
  | { kind: "complete"; connectionId: string; displayName: string; completePath: string };

/**
 * Result of the test-connection (`POST .../test`) call. Bases the cutover-
 * agnostic shape on the contract `IntegrationHealthResult` and narrows
 * `diagnostics` to the user fields the UI renders.
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

export type { IntegrationBindingUpdateInput as UpdateIntegrationInput, AgentAccess, AgentPathKind } from "@forge/contracts/integrations";
