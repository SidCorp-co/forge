/** Where an Autoflow ("Sidcorp Auto") platform answers: its GraphQL API, its shop MCP, a site's host. */

export const AUTOFLOW_DEFAULT_BASE_URL = 'https://auto.sidcorp.co';
export const AUTOFLOW_DEFAULT_MCP_URL = 'https://mcp.auto.sidcorp.co/mcp';

interface EndpointConfig {
  baseUrl?: unknown;
  mcpUrl?: unknown;
}

const trimmed = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value.replace(/\/+$/, '') : null;

export function autoflowBaseUrl(config: EndpointConfig): string {
  return trimmed(config.baseUrl) ?? AUTOFLOW_DEFAULT_BASE_URL;
}

export function autoflowGraphqlUrl(config: EndpointConfig): string {
  const base = autoflowBaseUrl(config);
  return base.endsWith('/graphql') ? base : `${base}/graphql`;
}

/** The shop MCP server (`backend-go/cmd/mcp`), streamable HTTP at `/mcp`. */
export function autoflowMcpUrl(config: EndpointConfig): string {
  return trimmed(config.mcpUrl) ?? AUTOFLOW_DEFAULT_MCP_URL;
}

/** A site is served at `<shop>.<platform host>` until it adds a domain of its own. */
export function autoflowSiteUrl(config: EndpointConfig, shop: string): string {
  return `https://${shop}.${new URL(autoflowBaseUrl(config)).host}`;
}
