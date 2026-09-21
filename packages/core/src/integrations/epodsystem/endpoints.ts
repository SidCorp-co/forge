const DEFAULT_ENDPOINT = 'https://admin.epodsystem.com';
const DEFAULT_MCP_URL = 'https://mcp.epodsystem.com/mcp';

export function epodsystemEndpoint(): string {
  return (process.env.EPODSYSTEM_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

/** The Epodsystem MCP server injected into the runner (env-overridable, global). */
export function epodsystemMcpUrl(): string {
  return process.env.EPODSYSTEM_MCP_URL || DEFAULT_MCP_URL;
}

export function epodsystemGraphqlBase(): string {
  const base = epodsystemEndpoint();
  return base.endsWith('/graphql') ? base : `${base}/graphql`;
}
