/**
 * ISS-387 — Epodsystem host resolution.
 *
 * The MCP host is a single global endpoint (no region split, unlike postman).
 * The GraphQL base is derived from the per-store `endpoint` configured on the
 * integration so the test-connection call targets the right store backend.
 */

/** The Epodsystem MCP server injected into the runner (global, single host). */
export function epodsystemMcpUrl(): string {
  return 'https://mcp.epodsystem.com/mcp';
}

/**
 * GraphQL base used for the test-connection `apiKeyContext` call. Derived from
 * the store endpoint; tolerates a trailing slash and an already-`/graphql`
 * suffixed endpoint.
 */
export function epodsystemGraphqlBase(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/graphql') ? trimmed : `${trimmed}/graphql`;
}
