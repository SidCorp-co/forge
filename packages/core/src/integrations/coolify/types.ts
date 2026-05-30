import type { IntegrationEnvironment } from '../../db/schema.js';

export interface CoolifyConfig extends Record<string, unknown> {
  /** Base URL of the Coolify API, e.g. https://coolify.example.com */
  baseUrl: string;
  /** Coolify resource (application) UUID to deploy. */
  resourceUuid: string;
  /** Git branch the resource is wired to deploy from. */
  branch: string;
  /** Mirror of project_integrations.environment; convenience for adapter logic. */
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
