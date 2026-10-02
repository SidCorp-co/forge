/** What an Autoflow connection and binding hold once validated and health-checked. */

export interface AutoflowConfig extends Record<string, unknown> {
  baseUrl?: string;
  mcpUrl?: string;
  /** BINDING tier: the `<shop>` of `<shop>.auto.sidcorp.co`. The keys below it are resolved by healthcheck. */
  shop?: string;
  orgId?: string;
  storeId?: string;
  storeSlug?: string;
  storeName?: string;
  themeId?: string;
  commerceEnabled?: boolean;
}

/** `sat_` (12h, the only credential the shop MCP admits) renewed from `srt_` (90d, rotating): `refresh.ts`. */
export interface AutoflowSecrets extends Record<string, unknown> {
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  /** The `mcpc_` client the pair was issued to; the platform refuses a refresh without it. */
  clientId?: string;
  refreshRefusedAt?: string;
  refreshRefusedReason?: string;
  previousAccessToken?: string;
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
