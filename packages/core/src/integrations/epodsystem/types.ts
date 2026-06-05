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
 * Non-secret Epodsystem target — stored in `project_integrations.config` (jsonb).
 * This is the "store context" a skill reads via `forge_storefront_target`; it
 * intentionally carries NO API key. `environment` mirrors the row column.
 *
 * Decision (ISS-387): ONE store per project. staging ↔ theme draft,
 * prod ↔ theme main; publish promotes draft → main on the same store.
 */
export interface EpodsystemConfig extends Record<string, unknown> {
  /** GraphQL/admin endpoint of the store backend (e.g. https://<store>.epodsystem.com). */
  endpoint: string;
  /** Store slug; resolved by the healthcheck `apiKeyContext` query. */
  storeSlug?: string;
  /** Human-readable store name; resolved by the healthcheck. */
  storeName?: string;
  /** Live (main) theme id. */
  themeId?: string;
  /** Draft theme id used as the build target (staging). */
  draftThemeId?: string;
  /** Whether the store has commerce features enabled (ecommerce vs blog/landing). */
  commerceEnabled?: boolean;
  /** Mirror of project_integrations.environment; convenience for adapter logic. */
  environment: IntegrationEnvironment;
}

/** Secret material — encrypted into `project_integrations.secretsEnc`. */
export interface EpodsystemSecrets extends Record<string, unknown> {
  /** Epodsystem API key (`crmk_...`). Bearer for both the MCP server and the GraphQL `apiKeyContext` call. */
  apiKey: string;
}

/**
 * Shape of the GraphQL `apiKeyContext` reply (only the non-secret identity
 * fields we surface as healthcheck diagnostics + config). Field names are kept
 * optional so a partial backend response never throws.
 */
export interface ApiKeyContextResponse {
  data?: {
    apiKeyContext?: {
      storeSlug?: string | null;
      storeName?: string | null;
      themeId?: string | null;
      draftThemeId?: string | null;
      commerceEnabled?: boolean | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string }> | null;
}
