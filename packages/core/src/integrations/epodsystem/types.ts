import type { IntegrationEnvironment } from '../../db/schema.js';

/**
 * ISS-387 — Epodsystem integration types.
 *
 * Epodsystem's role in Forge mirrors Postman: a website/store managed through
 * the official Epodsystem MCP server injected into the runner (see
 * `resolver.ts`). Core makes ONE direct call — the test-connection GraphQL
 * `apiKeyContext` query (mirrors postman `GET /me`), which validates the
 * `crmk_` API key and surfaces non-secret store identity back to the config UI.
 */

/**
 * Non-secret Epodsystem target — stored in the integration connection's `config`
 * (jsonb). This is the "store context" a skill reads via `forge_storefront_target`;
 * it intentionally carries NO API key and NO endpoint (the endpoint is fixed
 * platform config from `EPODSYSTEM_ENDPOINT`, not per-store). `environment`
 * mirrors the binding's environment.
 *
 * Decision (ISS-387): ONE store per project. staging ↔ theme draft,
 * prod ↔ theme main; publish promotes draft → main on the same store.
 */
export interface EpodsystemConfig extends Record<string, unknown> {
  /** Organization id; from `apiKeyContext.organization_id`. */
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
  /** Mirror of the binding's `environment`; convenience for adapter logic. */
  environment: IntegrationEnvironment;
}

/** Secret material — encrypted into the connection's `secretsEnc`. */
export interface EpodsystemSecrets extends Record<string, unknown> {
  /** Epodsystem API key (`crmk_...`). Bearer for both the MCP server and the GraphQL `apiKeyContext` call. */
  apiKey: string;
}

/**
 * One store entry under `apiKeyContext.stores` (snake_case, per the Epodsystem
 * GraphQL schema). `active_theme_id` is the live (main) theme. There is NO
 * draft-theme id on this type — the draft is resolved later via the MCP layer.
 */
export interface ApiKeyStore {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
  commerce_enabled?: boolean | null;
  active_theme_id?: string | null;
}

/**
 * Shape of the GraphQL `apiKeyContext` reply. The org's store(s) live under
 * `stores` (a list); ISS-387 is one-store-per-project, so the adapter reads
 * `stores[0]`. Fields are optional so a partial backend response never throws.
 */
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

/**
 * Best-effort enrichment reply: `storeThemes` (to name the active theme) +
 * `storeDomains` (to get the real primary domain). Optional throughout so a
 * partial/failed enrichment never throws — it just leaves fields unresolved.
 */
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
