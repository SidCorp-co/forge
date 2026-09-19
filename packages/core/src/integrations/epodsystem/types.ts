export interface EpodsystemConfig extends Record<string, unknown> {
  orgId?: string;
  /** Granted key scopes; from `apiKeyContext.scopes` (e.g. `["products:write", ...]` or `["*"]`). */
  scopes?: string[];
  /** Store id; from `apiKeyContext.stores[0].id`. */
  storeId?: string;
  /** Store slug; from `apiKeyContext.stores[0].slug`. */
  storeSlug?: string;
  /** Human-readable store name; from `apiKeyContext.stores[0].name`. */
  storeName?: string;
  /** Live (main) theme id; from `apiKeyContext.stores[0].active_theme_id`. */
  themeId?: string;
  /** Live (main) theme name; resolved (best-effort) via `storeThemes`. */
  themeName?: string;
  /** Draft theme id used as the build target (staging); created build-time by `customize_theme`, NOT at healthcheck. */
  draftThemeId?: string;
  /** Whether the store has commerce features enabled (ecommerce vs blog/landing). */
  commerceEnabled?: boolean;
  /** Primary published domain; resolved (best-effort) via `storeDomains`. Draft preview = this domain + `?preview_token=<token>`. */
  domain?: string;
}

/** Secret material — encrypted into the connection's `secretsEnc`. */
export interface EpodsystemSecrets extends Record<string, unknown> {
  /** Epodsystem API key (`crmk_...`). Bearer for both the MCP server and the GraphQL `apiKeyContext` call. */
  apiKey: string;
  previousApiKey?: string;
  /** ISO-8601 timestamp; if past, `previousApiKey` is ignored. */
  previousTokenExpiresAt?: string;
}

export interface ApiKeyStore {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
  commerce_enabled?: boolean | null;
  active_theme_id?: string | null;
}

export interface ApiKeyContextResponse {
  data?: {
    apiKeyContext?: {
      organization_id?: string | null;
      scopes?: string[] | null;
      stores?: ApiKeyStore[] | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string }> | null;
}

export interface StoreContextResponse {
  data?: {
    storeThemes?: Array<{
      id?: string | number | null;
      name?: string | null;
      role?: string | null;
      is_active?: boolean | null;
    }> | null;
    storeDomains?: Array<{ domain?: string | null; is_primary?: boolean | null }> | null;
  } | null;
  errors?: Array<{ message?: string }> | null;
}
