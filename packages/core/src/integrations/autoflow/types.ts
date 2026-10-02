/** What an Autoflow connection and binding hold once validated and health-checked. */

export interface AutoflowConfig extends Record<string, unknown> {
  /** Platform origin; absent = `AUTOFLOW_DEFAULT_BASE_URL`. */
  baseUrl?: string;
  /** Shop MCP URL; absent = `AUTOFLOW_DEFAULT_MCP_URL`. */
  mcpUrl?: string;
  /** BINDING tier: the site (store slug) this binding builds — the `<shop>` of `<shop>.auto.sidcorp.co`. */
  shop?: string;
  /** Resolved by healthcheck from `apiKeyContext`, never typed by a caller. */
  orgId?: string;
  storeId?: string;
  storeSlug?: string;
  storeName?: string;
  themeId?: string;
  commerceEnabled?: boolean;
}

export interface AutoflowSecrets extends Record<string, unknown> {
  /**
   * The platform's OAuth 2.1 access token (`sat_…`), minted for ONE workspace + site. It is the only
   * credential the shop MCP's `/mcp` door admits, and the backend GraphQL accepts it too.
   */
  accessToken: string;
  previousAccessToken?: string;
  /** ISO-8601; once past, `previousAccessToken` is ignored. */
  previousTokenExpiresAt?: string;
}

export interface AutoflowStore {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
  commerce_enabled?: boolean | null;
  active_theme_id?: string | null;
}

export interface AutoflowApiKeyContext {
  organization_id?: string | null;
  stores?: AutoflowStore[] | null;
}
