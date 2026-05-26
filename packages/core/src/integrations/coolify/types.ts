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

export interface CoolifyDeployResponse {
  deployment_uuid: string;
  message?: string;
}

export interface CoolifyResourceResponse {
  uuid: string;
  name?: string;
  status?: string;
}

export interface CoolifyRollbackResponse {
  deployment_uuid: string;
  message?: string;
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
