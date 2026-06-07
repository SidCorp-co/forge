import type { IntegrationEnvironment } from '../../db/schema.js';

/** Postman data-residency region. EU swaps both the REST and MCP hosts. */
export type PostmanRegion = 'us' | 'eu';

/**
 * Postman MCP server mode. `minimal` exposes the write-oriented tool subset
 * (enough to create/update collections + environments); `full` exposes the
 * complete tool surface. Default is `minimal` (ISS-336 decision 2).
 */
export type PostmanMode = 'minimal' | 'full';

/**
 * Non-secret Postman target — stored in `project_integrations.config` (jsonb).
 * This is the "write here" context a skill reads via `forge_postman_target`;
 * it intentionally carries NO API key.
 */
export interface PostmanConfig extends Record<string, unknown> {
  /** Workspace UUID the project writes into (optional until the user picks one). */
  workspaceId?: string;
  /** Human-readable workspace name; defaults to `Forge Integration`. */
  workspaceName: string;
  /** Collection UID/ID the project writes its artifact into (optional). */
  collectionId?: string;
  /** Data-residency region; drives both the MCP and REST host swap. */
  region: PostmanRegion;
  /** MCP server mode injected into the runner. */
  mode: PostmanMode;
  /** Mirror of project_integrations.environment; convenience for adapter logic. */
  environment: IntegrationEnvironment;
}

/** Secret material — encrypted into `project_integrations.secretsEnc`. */
export interface PostmanSecrets extends Record<string, unknown> {
  /** Postman API key (PMAK-...). Bearer for MCP, X-Api-Key for the REST /me call. */
  apiKey: string;
  /**
   * Previous API key, retained during the 24h rotation window so a `GET /me`
   * healthcheck issued before the new key fully propagates can still
   * authenticate. Mirrors the Coolify dual-token pattern (ISS-405).
   */
  previousApiKey?: string;
  /** ISO-8601 timestamp; if past, `previousApiKey` is ignored. */
  previousTokenExpiresAt?: string;
}

/** Shape of a successful Postman `GET /me` response (the fields we surface). */
export interface PostmanMeResponse {
  user?: {
    id?: number | string;
    username?: string;
    email?: string;
    fullName?: string;
  };
}
