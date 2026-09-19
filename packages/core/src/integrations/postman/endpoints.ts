import type { PostmanMode, PostmanRegion } from './types.js';

export function postmanMcpUrl(region: PostmanRegion, mode: PostmanMode): string {
  const host = region === 'eu' ? 'mcp.eu.postman.com' : 'mcp.postman.com';
  const path = mode === 'minimal' ? 'minimal' : 'mcp';
  return `https://${host}/${path}`;
}

/** REST API base used for the test-connection `GET /me` call. */
export function postmanRestBase(region: PostmanRegion): string {
  return region === 'eu' ? 'https://api.eu.postman.com' : 'https://api.getpostman.com';
}
