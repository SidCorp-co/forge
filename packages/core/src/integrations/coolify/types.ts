export interface CoolifyTarget {
  /** Stable per-target id (server-assigned if omitted on write). */
  id: string;
  /** Human label shown in the UI, e.g. "Backend" / "Frontend". */
  label: string;
  /** Coolify resource (application) UUID to deploy. */
  resourceUuid: string;
  healthUrl?: string;
}

export interface CoolifyConfig extends Record<string, unknown> {
  /** Base URL of the Coolify API, e.g. https://coolify.example.com (connection-tier). */
  baseUrl: string;
  /** Deploy targets for this project+stage (binding-tier). One per Coolify app. */
  targets: CoolifyTarget[];
}

export interface CoolifySecrets extends Record<string, unknown> {
  /** Current Coolify API token (Bearer). */
  apiToken: string;
  previousApiToken?: string;
  /** ISO-8601 timestamp; if past, previousApiToken is ignored. */
  previousTokenExpiresAt?: string;
}

/** One entry of Coolify v4's `deployments[]` deploy response. */
export interface CoolifyDeployItem {
  deployment_uuid: string;
  resource_uuid?: string;
  message?: string;
}

export interface CoolifyDeployResponse {
  deployments?: CoolifyDeployItem[];
  deployment_uuid?: string;
  message?: string;
}

export interface CoolifyResourceResponse {
  uuid: string;
  name?: string;
  status?: string;
}

export interface CoolifyCancelResponse {
  message?: string;
  deployment_uuid?: string;
  status?: string;
}

/** One entry of `GET /api/v1/applications/{uuid}/rollback-images`. */
export interface CoolifyRollbackImage {
  tag?: string;
  created_at?: string;
  is_current?: boolean;
}

/**
 * Coolify v4 `GET /api/v1/applications/{uuid}/rollback-images`.
 */
export interface CoolifyRollbackImagesResponse {
  current?: string | null;
  images?: CoolifyRollbackImage[];
}

/**
 * Coolify v4 `POST /api/v1/applications/{uuid}/rollback`.
 */
export interface CoolifyRollbackResponse {
  message?: string;
  deployment_uuid?: string;
}

export interface CoolifyApplicationResponse {
  uuid: string;
  name?: string;
  fqdn?: string | null;
  description?: string | null;
  git_repository?: string;
  git_branch?: string;
  git_commit_sha?: string;
  status?: string;
}

export interface CoolifyApplicationLogsResponse {
  logs?: string;
}

/** One line of a Coolify deployment log (when `logs` is decoded to an array). */
export interface CoolifyDeploymentLogLine {
  output?: string;
  type?: string;
  timestamp?: string;
}

export interface CoolifyDeploymentResponse {
  deployment_uuid?: string;
  status?: string;
  logs?: string | CoolifyDeploymentLogLine[];
  commit?: string;
  id?: number;
}
