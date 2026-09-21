import { postmanMcpUrl } from './endpoints.js';
import type { PostmanConfig } from './types.js';

/** Build the `mcpServers.postman` entry the runner merges into its config. */
export function buildPostmanMcpEntry(
  config: PostmanConfig,
  apiKey: string,
): Record<string, unknown> {
  return {
    type: 'http',
    url: postmanMcpUrl(config.region ?? 'us', config.mode ?? 'minimal'),
    headers: { Authorization: `Bearer ${apiKey}` },
    enabled: true,
  };
}
