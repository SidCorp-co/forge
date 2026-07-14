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
  status?: string; // 'queued' | 'in_progress' | 'finished' | 'failed' | 'cancelled' | ...
  logs?: string | CoolifyDeploymentLogLine[];
  id?: number;
}

/**
 * Shape Coolify posts to /in/:slug. Fields beyond status + deployment_uuid
 * are best-effort — Coolify's payload evolves across versions; the adapter
 * only relies on those two.
 */
export interface CoolifyWebhookPayload {
  event: 'deploy.started' | 'deploy.succeeded' | 'deploy.failed' | string;
  deployment_uuid?: string;
  application_uuid?: string;
  status?: 'success' | 'failed' | 'in_progress' | string;
  message?: string;
}
