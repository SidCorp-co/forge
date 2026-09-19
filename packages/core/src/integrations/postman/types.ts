export type PostmanRegion = 'us' | 'eu';

export type PostmanMode = 'minimal' | 'full';

export interface PostmanConfig extends Record<string, unknown> {
  workspaceId?: string;
  workspaceName: string;
  collectionId?: string;
  /** Data-residency region; drives both the MCP and REST host swap. */
  region: PostmanRegion;
  /** MCP server mode injected into the runner. */
  mode: PostmanMode;
}

/** Secret material — encrypted into `project_integrations.secretsEnc`. */
export interface PostmanSecrets extends Record<string, unknown> {
  /** Postman API key (PMAK-...). Bearer for MCP, X-Api-Key for the REST /me call. */
  apiKey: string;
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
