import type { IntegrationEnvironment } from '../../db/schema.js';

/**
 * One Coolify application this project+environment deploys. A single binding
 * fans out to many targets (e.g. a separate BE and FE resource), each its own
 * Coolify application UUID. `id` is a stable per-target key used to map an
 * outbound deploy delivery back to its inbound webhook + to render the target
 * row in the UI.
 */
export interface CoolifyTarget {
  /** Stable per-target id (server-assigned if omitted on write). */
  id: string;
  /** Human label shown in the UI, e.g. "Backend" / "Frontend". */
  label: string;
  /** Coolify resource (application) UUID to deploy. */
  resourceUuid: string;
}

export interface CoolifyConfig extends Record<string, unknown> {
  /** Base URL of the Coolify API, e.g. https://coolify.example.com (connection-tier). */
  baseUrl: string;
  /** Deploy targets for this project+environment (binding-tier). One per Coolify app. */
  targets: CoolifyTarget[];
  /** Mirror of the binding environment; convenience for adapter logic. */
  environment: IntegrationEnvironment;
}

export interface CoolifySecrets extends Record<string, unknown> {
  /** Current Coolify API token (Bearer). */
  apiToken: string;
  /**
   * Previous API token, retained during the 24h rotation window so deploys
   * in flight when the token is rotated can still authenticate.
   */
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

/**
 * Coolify v4 deploy response. The documented shape is `{ deployments: [...] }`;
 * some versions surface a top-level `deployment_uuid` instead, so both are
 * optional and the adapter resolves the uuid defensively.
 */
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

/**
 * Coolify v4 `POST /api/v1/deployments/{uuid}/cancel`. A deployment that has
 * already finished answers 400 with its own `message`, not this shape.
 */
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
// cm:guard an EMPTY `images` is NOT "this application has no older builds" — `ApplicationsController::rollback_images` catches every throwable from the remote `docker images` call and answers 200 with `{current:null, images:[]}`, so an unreachable server is byte-identical to a clean one. `assertRollbackTagListed` refuses on an empty list for exactly this reason.
export interface CoolifyRollbackImagesResponse {
  current?: string | null;
  images?: CoolifyRollbackImage[];
}

/**
 * Coolify v4 `POST /api/v1/applications/{uuid}/rollback`.
 */
// cm:guard `deployment_uuid` is OPTIONAL on a 200 and its absence is a rollback that did NOT happen — `queue_application_deployment` answers `status:'skipped'` with a bare `message` and HTTP 200 when a deployment for that commit is already queued. Reading the 200 alone reports a rollback nobody performed.
export interface CoolifyRollbackResponse {
  message?: string;
  deployment_uuid?: string;
}

/**
 * Coolify v4 `Application`, narrowed to the identity fields Forge shows an
 * operator. `git_commit_sha` is Coolify's OWN record of what it deployed,
 * which is why a bound target can be checked without probing the running app.
 */
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

/**
 * Coolify v4 `GET /api/v1/applications/{uuid}/logs` — recent RUNTIME container
 * logs as one string. CAVEAT (verified 2026-07-14 against getforge-beta): for a
 * docker-compose application this returns only ONE container's logs and the
 * public API exposes NO working per-service selector — `container=`/`service=`
 * query params are ignored (it returned the web-v2 container regardless). So a
 * compose target cannot be narrowed to a specific service through this endpoint;
 * it is reliable only for single-container applications.
 */
export interface CoolifyApplicationLogsResponse {
  logs?: string;
}

/** One line of a Coolify deployment log (when `logs` is decoded to an array). */
export interface CoolifyDeploymentLogLine {
  output?: string;
  type?: string;
  timestamp?: string;
}

/**
 * Coolify v4 `GET /api/v1/deployments/{uuid}`. The shape varies across Coolify
 * versions, so every field is optional and callers parse defensively. `logs`
 * is most commonly a JSON-encoded array of `{ output, type, timestamp }`
 * objects, but some versions surface a raw string — `flattenLogs` handles both.
 */
export interface CoolifyDeploymentResponse {
  deployment_uuid?: string;
  // cm:edge contract -> packages/core/src/integrations/coolify/confirm.ts — the string values here are classified there, and a Coolify version that renames one is read as non-terminal until the deadline rather than as success.
  status?: string;
  logs?: string | CoolifyDeploymentLogLine[];
  commit?: string;
  id?: number;
}
