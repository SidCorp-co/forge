/**
 * ISS-387 — Epodsystem host resolution.
 *
 * Both hosts are FIXED service-to-service platform config — they are NOT
 * per-store and NOT user-supplied. They come from env vars with production
 * defaults, so the only thing an operator configures per project is the
 * `crmk_` API key (which resolves the org/store on its own).
 */

/** Default GraphQL/admin host when `EPODSYSTEM_ENDPOINT` is unset. */
const DEFAULT_ENDPOINT = 'https://admin.epodsystem.com';
/** Default MCP host when `EPODSYSTEM_MCP_URL` is unset. */
const DEFAULT_MCP_URL = 'https://mcp.epodsystem.com/mcp';

/**
 * The Epodsystem platform host (GraphQL/admin). Read from `EPODSYSTEM_ENDPOINT`,
 * defaulting to the production admin host. Trailing slashes are trimmed.
 */
export function epodsystemEndpoint(): string {
  return (process.env.EPODSYSTEM_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

/** The Epodsystem MCP server injected into the runner (env-overridable, global). */
export function epodsystemMcpUrl(): string {
  return process.env.EPODSYSTEM_MCP_URL || DEFAULT_MCP_URL;
}

/**
 * GraphQL base used for the test-connection `apiKeyContext` call — the platform
 * endpoint (`EPODSYSTEM_ENDPOINT`) with `/graphql` appended. Tolerates an
 * endpoint that already ends in `/graphql`.
 */
export function epodsystemGraphqlBase(): string {
  const base = epodsystemEndpoint();
  return base.endsWith('/graphql') ? base : `${base}/graphql`;
}
